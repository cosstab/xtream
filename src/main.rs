use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::{mpsc, RwLock};
use tokio_stream::wrappers::UnboundedReceiverStream;
use uuid::Uuid;
use warp::ws::{Message, WebSocket};
use warp::{http::Uri, Filter};
use serde_json::{json, Value};
use clap::Parser;

mod room;

/// Our global unique user id counter.
static NEXT_USER_ID: AtomicU8 = AtomicU8::new(1);

type Rooms<'a> = Arc<RwLock<HashMap<String, room::SharedRoom>>>;

// SDP and ICE candidates for OBS
//type Sdp = Arc<Mutex<String>>;

#[derive(Parser)]
#[command(version, about, long_about = None)]
struct Cli {
    /// IPv4 address or path to the Unix socket the server will be listening on
    addr: String,
    
    /// Listening port
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Enable https
    #[arg(long)]
    https: bool,

    /// Path to https certificate
    #[arg(short, long, default_value = "cert.pem")]
    cert: String,

    /// Path to https private key
    #[arg(short, long,  default_value = "key.rsa")]
    key: String,

    /// Use Unix socket instead of IP
    #[arg(short, long)]
    usock: bool,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let rooms = Rooms::default();
    // Put rooms into a Warp filter, so we can pass them to every petition
    let rooms = warp::any().map(move || rooms.clone());

    // Redirects to a new room when accessing the root page
    let dispatcher = warp::path::end()
        .map(|| {
            let uuid = Uuid::new_v4().to_string();
            warp::redirect::found(format!("/{uuid}/").parse::<Uri>()
                                .expect("Uri should be parsed without problems?"))
        });

    // The shared SDP string for OBS
    //let sdp = Sdp::default();
    // Create a filter to add it to the filter chain
    //let sdp = warp::any().map(move || sdp.clone());

    // GET /:roomId/signaling -> Websocket upgrade
    let ws_signaling = warp::path::param()
        .and(warp::path("signaling"))
        .and(warp::ws()) //The `ws()` filter will prepare Websocket handshake...
        //.and(sdp.clone())
        .and(rooms)
        .map(|room_id: String, ws: warp::ws::Ws, rooms| {
            // This will call our function if the handshake succeeds.
            ws.on_upgrade(move |socket| {
                new_ws_connection(socket, room_id, rooms)
            })
        });

    // GET /:roomId -> Serve frontend files in each room
    let frontend = warp::path::param()
        .and(warp::fs::dir("frontend"))
        .map(|_room_id: String, file| file);

    // WHIP API
    /*let whip = warp::path("whip")
        .and(warp::post()) //it's probably desirable to have a warp::body::content_length_limit here
        .and(warp::header::exact("Content-Type", "application/sdp"))
        .and(warp::body::bytes())
        .and(sdp)
        .and(users)
        .and_then(|bytes: bytes::Bytes, sdp: Arc<Mutex<String>>, users| manage_whip_request(bytes, sdp, users));*/

    let routes = dispatcher.or(frontend.or(ws_signaling));

    if cli.usock {
        use tokio::net::UnixListener;
        use tokio_stream::wrappers::UnixListenerStream;

        let listener = UnixListener::bind(cli.addr).expect("Problem when binding to Unix socket");
        let incoming = UnixListenerStream::new(listener);

        warp::serve(routes)
            .run_incoming(incoming)
            .await;
    } else {
        let ip: IpAddr = cli.addr.parse().expect("Can't parse IP address");

        if cli.https {
            warp::serve(routes)
                .tls()
                .cert_path(cli.cert)
                .key_path(cli.key)
                .run((ip, cli.port))
                .await;
        } else {
            warp::serve(routes)
                .run((ip, cli.port))
                .await;
        }
    }

    //future::join(http, https).await;
}

async fn new_ws_connection<'a>(ws: WebSocket, room_id: String, rooms: Rooms<'a>) {
    // Use a counter to assign a new unique ID for this user.
    let user_id = NEXT_USER_ID.fetch_add(1, Ordering::Relaxed);

    let this_room;
    if rooms.read().await.contains_key(&room_id) {
        println!("User {user_id} joining room {room_id}");
        this_room = rooms.read().await.get(&room_id)
            .expect("We should be able to get the room, since the HashMap contains the key.")
            .clone();
    } else {
        println!("User {user_id} joining NEW room {room_id}");
        this_room = room::create_room();
        rooms.write().await.insert(room_id, this_room.clone());
    }

    // user_connected will run until the socket is closed
    user_connected(ws, &this_room, user_id)
        .await
        .unwrap_or_else(|e| { 
            println!("Disconnecting user {}, reason: {}", user_id, e);
        });
    
    // The socket closed, so remove user from the list and notify others
    let json = json!({
        "type": "user-left",
        "id": user_id
    });

    let users = &mut this_room.write().await
        .users;
    broadcast_to_room(user_id, &json.to_string(), &users)
        .await;
    users.remove(&user_id);

    println!("Good bye user: {user_id}");
}

async fn user_connected(ws: WebSocket, room: &room::SharedRoom, user_id: u8) -> Result<(),Box<dyn std::error::Error>>{
    // Split the socket into a message sender and receiver.
    let (user_ws_tx, mut user_ws_rx) = ws.split();

    let tx = create_sender(user_ws_tx, user_id).await;

    // Periodically ping user to keep the socket alive
    let tx_clone = tx.clone();
    thread::spawn(move || {
        loop {
            match tx_clone.send(Message::ping("")) {
                Ok(_) => thread::sleep(Duration::from_secs(5)),
                Err(_) => break,
            }
        }
    });

    // Save the sender in our list of connected users.
    room.write().await
        .users
        .insert(user_id, tx.clone());

    // Send JSON list of online users to the new one.
    let users = room.read().await.users.clone();
    let id_vec = users.keys().cloned().collect::<Vec<u8>>();
    let json = json!({
        "type": "room-status",
        "myId": user_id,
        "users": id_vec
    });
    tx.send(Message::text(json.to_string()))?;

    // Send previous room context
    let room_state = room.read().await.state.clone();
    for msg in room_state.iter() {
        tx.send(Message::text(msg))?;
    }
 
    // Notify the others that a new user joined
    let json = json!({
        "type": "new-user",
        "id": user_id
    });
    broadcast_to_room(user_id, &json.to_string(), &users).await;

    // Manage the received JSON messages
    while let Some(msg) = user_ws_rx.next().await {
        manage_message(user_id, msg?, &room).await?;
    }

    // user_ws_rx stream will keep processing as long as the user stays
    // connected. Once they properly disconnect, return Ok.
    Ok(())
}

async fn create_sender(mut user_ws_tx: SplitSink<WebSocket, Message>, user_id: u8) -> UnboundedSender<Message> {
    // Use an MPSC (multiple producers, single consumer) unbounded channel to handle buffering 
    // and flushing of messages of the WebSocket.
    // We'll return the sender that other connections will use to communicate with this user.
    let (tx, rx) = mpsc::unbounded_channel();
    let mut rx = UnboundedReceiverStream::new(rx);
    let tx_clone = tx.clone();

    tokio::task::spawn(async move {
        while let Some(message) = rx.next().await {
            let result = user_ws_tx.send(message).await;

            match result {
                Ok(_) => (),
                Err(e) => {
                    drop(tx_clone);
                    println!("Websocket send error: '{}' when sending to {}", e, user_id); //TODO: try to resend?
                    break;
                }
            }
        }
    });

    return tx;
}

async fn broadcast_to_room(my_id: u8, msg: &str, users: &room::Users) {
    for (&uid, tx) in users.iter() {
        if my_id != uid {
            tx.send(Message::text(msg))
                .unwrap_or_else(|e| {
                    println!("Couldn't send message: {}", e); //TODO: try to resend?
                });
        }
    };
}

async fn manage_message(my_id: u8, msg: Message, room: &room::SharedRoom) -> Result<(),Box<dyn std::error::Error>>{
    if msg.is_pong() { return Ok(()); }

    let msg = msg.to_str()
        .or(Err("Non text message received"))?;

    let parsed_msg: Value = serde_json::from_str(msg)?;

    // Save certain messages into room_state so new connections get previous events
    let msg_type = parsed_msg["type"].as_str().unwrap_or("");
    match msg_type {
        "playlist-new-media" | "chat" | "user-identified"
            => room.write().await
                .state.push(msg.to_string()),
        _ => ()
    }

    /*if m["to"] == 0 {
        match m["sdp"]["sdp"].as_str() {
            Some(received_sdp) => {
                let mut sdp = sdp.lock().await;
                *sdp = received_sdp.to_string();
                println!("{}", *sdp);
            },
            None => (), //Ignore ICE messages for the WHIP encoder
        }

        // Dont broadcast messages addressed to the WHIP encoder
        return Ok(());
    }*/

    match parsed_msg["to"].as_str() {
        Some(to) => { //Forward msg to the intended user
            match room.read().await
                    .users.get(&to.parse::<u8>()?) {
                Some(sender) => { sender.send(Message::text(msg))?; },
                None => return Err("Recipient doesn't exist.".into()),
            }
        },
        None => { //No 'to' in the received msg, so broadcast it to everybody except this user
            for (&uid, tx) 
            in room.read().await
                .users.iter() {

                if my_id != uid {
                    tx.send(Message::text(msg))?;
                }

            }
        }
    }

    Ok(())
}

/*async fn manage_whip_request(bytes: bytes::Bytes, sdp: Arc<Mutex<String>>, users: Users) -> Result<Response<String>, Infallible>{
    let msg = json!({
        "type": "video-offer",
        "from": 0,
        "to": 1,
        "sdp": {
            "type": "offer",
            "sdp" : std::str::from_utf8(&bytes).unwrap(),
        }
    });
    
    broadcast_to_room(0, &msg.to_string(), &users).await;
    
    let response_sdp;

    loop {
        let sdp = sdp
            .lock()
            .await
            .to_string();

        if !sdp.is_empty() {
            response_sdp = sdp;
            break;
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    //sdp = sdp.replace("actpass", "active");
                        
    println!("bytes = {:?} \n\nsdp = {:?}", bytes, sdp);

    Ok(Response::builder()
        .status(201)
        .header("Content-Type", "application/sdp")
        .header("Location", "http://127.0.0.1:3031")
        .body(response_sdp)
        .unwrap()) //Only panics if header or status can't be parsed
}*/
