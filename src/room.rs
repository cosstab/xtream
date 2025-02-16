use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, RwLock};
use warp::filters::ws::Message;

/// Our state of currently connected users.
///
/// - Key is their id
/// - Value is a sender of `warp::ws::Message`
pub type Users = HashMap<u32, mpsc::UnboundedSender<Message>>;

type RoomState = Vec<String>;

pub struct Room {
    pub users: Users,
    pub state: RoomState
}

pub type SharedRoom = Arc<RwLock<Room>>;

pub fn create_room() -> SharedRoom {
    SharedRoom::new(
        RwLock::new(
            Room {
                users: Users::default(),
                state: RoomState::default(),
            }
    ))
}