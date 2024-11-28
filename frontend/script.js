import { StreamableFilePlayer, StreamPlayer } from './player.mjs'

var myId
const users = {}
//var sentStream
var streaming = false
//var relaying = false
var seeding = false
var roomPlayer = null

const FULLSYNC = true
var waitingToSync = false

var videoLoaded = false

//users[0] = {} //Create user for WHIP encoder

//----------------------------------- Frontend logic -----------------------------------
const localStream = document.getElementById("stream")
const userTable = document.getElementById("user-table")
const chatInput = document.getElementById("chat-input")
const chatTL = document.getElementById("chat-tl")
const debugTL = document.getElementById("debug-info")
const dropZone = window
const chatContainer = document.getElementById('chat-container')
const mainContainer = document.getElementById('main-container')
const playlistContainer = document.getElementById('playlist-container')

const sendBt = document.getElementById('send-bt')
const screenShareBt = document.getElementById('screen-share-bt')
const fullscreenBt = document.getElementById('fullscreen-bt')
const muteBt = document.getElementById('mute-bt')
const playPauseBt = document.getElementById('play-bt')
const nextBt = document.getElementById('next-bt')
const seekBar = document.getElementById('seek-bar')
const audioSelector = document.getElementById('audio-selector')
const subtitleSelector = document.getElementById('subtitle-selector')

// This function will be overwritten when the WebSocket connection is initialized
function sendMessage() {
  alert("Not connected to the server")
}

sendBt.addEventListener('click', () => sendMessage())

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    sendMessage()
    ev.preventDefault()
  }
})

screenShareBt.addEventListener('click', () => {
  getMediaStream().then((lStream) => {
    streaming = true
    localStream.srcObject = lStream
    streamToPeers(users)
  })
})

/*function streamObs(){
  let obs = users[0] = {}
  obs.peerConnection = createPeerConnection(0)
  handleNegotiationNeededEvent2(obs.peerConnection)
}*/

fullscreenBt.addEventListener('click', () => {
  if (!document.fullscreenElement)
    document.documentElement.requestFullscreen()
  else if (document.exitFullscreen)
    document.exitFullscreen()
})

muteBt.addEventListener('click', () => {
  localStream.muted = !localStream.muted
  muteBt.children[0].className = localStream.muted ? 'bi bi-volume-mute-fill' : 'bi bi-volume-down-fill'
})

playPauseBt.addEventListener('click', () => {
  sendVideoSync(localStream, { paused: !localStream.paused })
  if (localStream.paused) setTimeout(() => localStream.play(), 500)
  else localStream.pause()
})

nextBt.addEventListener('click', () => playItem(playing+1))

audioSelector.addEventListener('change', (ev) => {
  console.log('Changing audio track to ' + ev.target.selectedIndex)
  roomPlayer.selectAudioTrack(ev.target.selectedIndex)
})

subtitleSelector.addEventListener('change', (ev) => {
  const selectedTrack = parseInt(ev.target.selectedIndex)-1
  console.log('Changing subtitle track to ', selectedTrack)

  const textTracks = roomPlayer.videoElement.textTracks
  for (const track of textTracks){
    track.mode = 'disabled'
  }
  textTracks[selectedTrack].mode = 'showing'
})

let sBDragging = false

seekBar.addEventListener('mousedown', () => {
  sBDragging = true
})

seekBar.addEventListener('change', () => {
  const videoElement = roomPlayer.videoElement
  const wasPaused = videoElement.paused

  videoElement.pause()
  videoElement.currentTime = videoElement.duration * seekBar.value / 1000
  sendVideoSync(videoElement, { paused: wasPaused })

  if (!wasPaused) setTimeout(() => videoElement.play(), 500)

  sBDragging = false
})

setInterval(() => {
  if (!sBDragging)
    seekBar.value = (localStream.currentTime / localStream.duration) * 1000
}, 200)


//-------------------------- File drop zone
function preventDefaults (e) {
  e.preventDefault()
  e.stopPropagation()
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, preventDefaults, false)
})

dropZone.addEventListener('drop', dropHandler, false)

function dropHandler(ev) {
  console.log("File(s) dropped");
  
  [...ev.dataTransfer.items].forEach(async (item, i) => {
    if (item.kind === "file") {
      let file = item.getAsFile()
      console.log(`… file[${i}].name = ${file.name}`)
      
      console.log(file)
      addPlaylistItemFromFile(file)
    }
  })
}

function appendMessageToTL(msg) {
  const line = document.createElement('p')
  line.textContent = msg.from + ">" + msg.txt
  chatTL.appendChild(line)
  chatTL.scrollTop = chatTL.scrollHeight
}


//-------------------------- Background illumination
// We'll apply the filters to a low resolution buffer canvas for improved performance
const BUFFER_CANVAS_WIDTH = 15
const BUFFER_CANVAS_HEIGHT = 10
const bgIlluminationCtx = document.getElementById('bg-illumination').getContext('2d')
const bufferCanvasCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
bufferCanvasCtx.canvas.width = BUFFER_CANVAS_WIDTH
bufferCanvasCtx.canvas.height = BUFFER_CANVAS_HEIGHT
// Smoothing isn't needed, hopefully it will use less resources when disabled? 
bgIlluminationCtx.imageSmoothingEnabled = false
bufferCanvasCtx.imageSmoothingEnabled = true

// Filters in CSS are not applied to the buffer canvas (probably because 'display' was set to none?)
// so we apply them in JS:
bufferCanvasCtx.filter = 'saturate(200%)' //brightness(70%)

function bgIlluminationUpdate() {
  if (!localStream) return
  bufferCanvasCtx.drawImage(localStream, 0, 0, BUFFER_CANVAS_WIDTH, BUFFER_CANVAS_HEIGHT)

  bgIlluminationCtx.canvas.width = window.innerWidth
  bgIlluminationCtx.canvas.height = window.innerHeight
  bgIlluminationCtx.drawImage(bufferCanvasCtx.canvas, 0, 0, window.innerWidth, window.innerHeight)
}


//-------------------------- Layout
var mode = 'cinema' //cinema, flex-video, portrait

/* 
no-video
When there's no video, default state.

cinema
When player has 100% of height of the screen, and there is more than enough place for chat

flex-video
When there's no room for chat, the player will be squeezed

portrait
When player would take less than 60% of the height of the screen if fills the full width
of the screen
*/

const resizeLayout = () => {
  const containerRectangle = mainContainer.getBoundingClientRect()
  const playerRectangle = localStream.getBoundingClientRect()
  const chatContainerRectangle = chatContainer.getBoundingClientRect()

  const heightInPortraitMode = containerRectangle.width / (playerRectangle.width / playerRectangle.height)
  let chatMinWidth = window.getComputedStyle(chatContainer).flexBasis
  chatMinWidth = parseInt(chatMinWidth)

  var newMode

  if (!videoLoaded)
    newMode = 'no-video'
  else if (heightInPortraitMode <= containerRectangle.height*0.6) 
    newMode = 'portrait'
  else if (playerRectangle.height >= containerRectangle.height-1 && (chatContainerRectangle.width > chatMinWidth)) 
    newMode = 'cinema'
  else 
    newMode = 'flex-video'

  if (mode != newMode) {
    console.log(newMode)
    mode = newMode

    for (const elem of document.querySelectorAll("[mode]")) {
      elem.setAttribute('mode', mode)
    }
  }
}

const observer = new ResizeObserver(resizeLayout)

observer.observe(mainContainer)


//-------------------------- Color management
class Color {
  constructor (rgb) {
    this.rgb = rgb
    
    // Get max and min values from the RGB components
    this.min = rgb[0]
    this.max = rgb[0]
    this.minIdx = this.maxIdx = 0
    for (let j=1; j<3; j++) {
      let val = rgb[j]
      if (val < this.min) {
        this.min = val
        this.minIdx = j
      } else if (val > this.max) {
        this.max = val
        this.maxIdx = j
      }
    }

    this.vibrance = this.max - this.min
  }

  get hue() { // Hue ranges between 0 and 6 (not standard HSV/HSL)
    if (this._hue) return this._hue

    if (this.vibrance == 0) {
      this._hue = 0
      return 0
    }

    var a, b
    switch (this.minIdx) {
      case 0:
        a = this.rgb[1]
        b = this.rgb[2]
        break
      case 1:
        b = this.rgb[0]
        a = this.rgb[2]
        break
      case 2:
        a = this.rgb[0]
        b = this.rgb[1]
        break
    }

    this._hue = ((a-b)/this.vibrance) + (this.minIdx)*2 + 1

    return this._hue
  }
}

const COLOR_HUE_SEPARATION = 1

// Selects the 2 most vibrant colors from the current video frame to use them in the UI
// The program won't choose different shades of the same color thanks to COLOR_HUE_SEPARATION
function colorUpdate() {
  if (!localStream) return

  const colorPalette = [new Color([0,0,0]), new Color([0,0,0])]
  const bgColorData = bufferCanvasCtx.getImageData(0,0, BUFFER_CANVAS_WIDTH, BUFFER_CANVAS_HEIGHT).data
  pixelLoop: for (let i=0; i<bgColorData.length; i+=4) {
    const color = new Color([bgColorData[i], bgColorData[i+1], bgColorData[i+2]])

    if (color.vibrance > colorPalette.at(-1).vibrance) {
      for (let j=0; j<colorPalette.length; j++) {
        const colorSeparation = Math.abs(colorPalette[j].hue - color.hue)
        if (colorSeparation < COLOR_HUE_SEPARATION || (6 - colorSeparation) < COLOR_HUE_SEPARATION) {
          if (color.vibrance > colorPalette[j].vibrance) {
            colorPalette.splice(j, 1)
            break
          }
          continue pixelLoop
        }
      }

      for (let j=0; j<colorPalette.length; j++) {
        if (color.vibrance > colorPalette[j].vibrance) {
          colorPalette.splice(j, 0, color)
          if (colorPalette.length > 2) colorPalette.pop()
          break
        }
      }

      if (colorPalette.length < 2) colorPalette.push(color)
    }
  }

  var [r, g, b] = colorPalette[0].rgb
  const color1 = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  [r, g, b] = colorPalette[1].rgb
  const color2 = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)

  const root = document.documentElement
  root.style.setProperty('--color-1', color1)
  root.style.setProperty('--color-2', color2)
  chatContainer.style.setProperty('--color-gradient-1', color1)
  chatContainer.style.setProperty('--color-gradient-2', color2)
}

// Start background illumination loop
window.setInterval(bgIlluminationUpdate, 100)
window.setInterval(colorUpdate, 300)


//-------------------------- Video events
localStream.addEventListener('play', (event) => {
  playPauseBt.children[0].className = 'bi bi-pause-fill'
})

localStream.addEventListener('pause', (event) => {
  playPauseBt.children[0].className = 'bi bi-play-fill'
})

localStream.addEventListener("loadeddata", (event) => {
  console.log("Video loaded.")
})

localStream.addEventListener("canplay", (event) => {
  console.log("Can Play.")
  if (waitingToSync && FULLSYNC) {
    waitingToSync = false
    sendVideoSync(localStream, { paused: false })
    setTimeout(() => localStream.play(), 500)
  }
})

localStream.addEventListener("stalled", (event) => {
  console.error("Video stalled.")
})

localStream.addEventListener("suspend", (event) => {
  console.error("Data loading has been suspended.")
})


function sendVideoSync(video, opts={}) {
  sendToServer({
    type: "sync",
    to: opts.to,
    paused: opts.paused ?? video.paused,
    currentTime: video.currentTime
  })
}

function debug(msg, tx=false){
  const line = document.createElement('p')
  if (tx) line.textContent = "Sent: "
  line.textContent += JSON.stringify(msg)
  debugTL.appendChild(line)
}

async function updatePlayerControls() {
  localStream.innerHTML = '' //THIS WILL REMOVE OTHER ELEMENTS INSIDE THE <video> TAG, APART FROM TRACKS
  audioSelector.innerHTML = ''
  subtitleSelector.innerHTML = ''

  for (const track of await roomPlayer.listStreams('audio')){
    const option = document.createElement("option")
    option.text = `(${track.language}) ${track.metadata?.title ?? ''}`
    audioSelector.options.add(option)
  }

  const defaultOption = document.createElement('option')
  defaultOption.setAttribute('disabled', '')
  defaultOption.setAttribute('selected', '')
  subtitleSelector.options.add(defaultOption)
  for (const {meta, url} of await roomPlayer.getSubtitles()) {
    const subName = `${meta.metadata?.title} (${meta.language})`
    
    const track = document.createElement('track')
    track.src = url
    track.label = subName
    track.language = meta.language
    localStream.append(track)

    const option = document.createElement("option")
    option.text = subName
    subtitleSelector.options.add(option)
  }

  videoLoaded = true
  resizeLayout()
}

//------------------------------- Playlist -------------------------------
const playlist = []
var playing = null

async function addPlaylistItemFromFile(file){
  const player = new StreamableFilePlayer(localStream, file)

  const htmlElement = document.createElement('i')
  htmlElement.innerText = ' 🎞️ '
  htmlElement.setAttribute('title', file.name)
  playlistContainer.appendChild(htmlElement)

  const mediaUuid = window.crypto.randomUUID()
  await player.initialize()

  seeding = true
  sendToServer({
    type: 'playlist-new-media',
    from: myId,
    mediaUuid,
    name: file.name,
    metadata: player.metadata
  })
  const newLen = playlist.push({
    mediaUuid,
    player,
    htmlElement,
    remote: false
  })

  //if (newLen === 1) 
  playItem(newLen-1)
}

async function addPlaylistItemFromRemote(mediaUuid, name, metadata, ownerId) {
  if (users[ownerId] === undefined) return

  const player = new StreamPlayer(localStream, metadata)
  await player.initialize()

  const htmlElement = document.createElement('i')
  htmlElement.innerText = ' 🎞️ '
  htmlElement.setAttribute('title', name)
  playlistContainer.appendChild(htmlElement)

  const newLen = playlist.push({
    mediaUuid,
    player,
    htmlElement,
    remote: true,
    ownerId
  })

  //if (newLen === 1) 
  // Ask for the current video position
  console.log('Sending sync?')
  sendToServer({
    type: 'sync?',
    from: myId
  })
  playItem(newLen-1)
}

async function playItem(idx){
  if (!playlist[idx]) return
  if (playing !== null) playlist[playing].player.detach()
  playing = idx

  const {mediaUuid, player, htmlElement, remote, ownerId} = playlist[idx]
  roomPlayer = player

  // Set no-video mode of layout in case there was a previous video
  videoLoaded = false
  resizeLayout()

  if (remote) {
    await receiveMedia(mediaUuid, player, ownerId)
  } else {
    htmlElement.classList.add('loader')
    await player.loadStreams()
    await updatePlayerControls()
    htmlElement.classList.remove('loader')
  }
}

async function removePlaylistItemsFromUser(userId) {
  for (const [idx, item] of playlist.entries()) {
    if (item.ownerId == userId) {
      item.htmlElement.remove()
      item.player.detach()
      delete playlist[idx]
    }
  }
}

//------------------------------- WebSocket signaling channel -------------------------------
const webSocket = new WebSocket("wss://" + window.location.host + window.location.pathname + "signaling")

function sendToServer(msg){
  debug(msg, true)
  webSocket.send(JSON.stringify(msg))
}

webSocket.onopen = (event) => {
    sendMessage = () => {
        const msg = {
          type: "chat",
          from: myId,
          txt: chatInput.value
        }
        
        appendMessageToTL(msg)
        sendToServer(msg)
        chatInput.value = ""
    }
}

webSocket.onmessage = async (event) => {
    const msg = JSON.parse(event.data)

    //if ((msg.to !== undefined) && (msg.to != myId)) return

    debug(msg)
    console.log(msg.type)

    switch(msg.type) {
      case "chat":
        appendMessageToTL(msg)
        break
      case "video-offer":
        handleVideoOfferMsg(msg)
        break
      case "video-answer":
        handleVideoAnswerMsg(msg)
        break
      case "new-ice-candidate":
        handleNewICECandidateMsg(msg)
        break
      case "new-user":
        users[msg.id] = {}
        userTable.textContent = Object.keys(users)
        
        if (streaming) {
          let peersToConnect = {}
          peersToConnect[msg.id] = users[msg.id]
          streamToPeers(peersToConnect) //Pass new peer in object form
        }
        break
      case "user-left":
        users[msg.id].peerConnection?.close()
        delete users[msg.id]
        userTable.textContent = Object.keys(users)
        removePlaylistItemsFromUser(msg.id)
        break
      case "room-status":
        myId = msg.myId
        msg.users.forEach((user)=> {
          users[user] = {}
        })
        userTable.textContent = Object.keys(users)
        break
      case 'sync':
        if (localStream.currentTime != msg.currentTime) localStream.currentTime = msg.currentTime
        localStream.pause()

        if (!msg.paused) setTimeout(() => localStream.play(), 300)
        break
      case 'sync?':
        if (seeding) {
          if (FULLSYNC && !localStream.paused) {
            // If FULLSYNC is activated and video playing, wait for the new user to synchronize everybody
            localStream.pause()
            sendVideoSync(localStream, { paused: true })

            sendToServer({
              type: 'you-sync',
              to: msg.from,
              currentTime: localStream.currentTime
            })
          }
          else sendVideoSync(localStream, { to: msg.from })
        }
        break
      case 'you-sync':
        waitingToSync = true
        localStream.currentTime = msg.currentTime
        break
      case 'playlist-new-media':
        addPlaylistItemFromRemote(msg.mediaUuid, msg.name, msg.metadata, msg.from)
        break
      /*case 'request-media':
        createDataChannel(msg.from, msg.mediaUuid)
        break
      case "torrent":
        receiveTorrent(msg.magnet, msg.from)
        break
      case "torrent-signal":
        receivedTorrentSignal(msg.from, msg.data)
        break*/
    }
}

webSocket.onerror = (ev) => {
  console.error("WebSocket error: ", ev)
}

webSocket.onclose = (ev) => {
  console.error("WebSocket closed: ", ev)
}

//----------------------------------- WebRTC -----------------------------------
const WebRTCConnectionConfig = {
  iceServers: [
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ], 
}

function streamToPeers(peers) {
  Object.entries(peers).forEach(([peerId, peer]) => {
    peer.peerConnection?.close()
    peer.peerConnection = createPeerConnection(peerId)
    console.log("configuring peer " + peerId)

    localStream.srcObject.getTracks().forEach((track) => {
      console.log("adding " + track.kind + " track " + track.id)
      track.contentHint = "detail"
      track.contentHint = "music" //The music contentHint will only be set for audio tracks, detail for video
      peer.peerConnection.addTrack(track, localStream.srcObject)
    })

    configureCodecs(peer.peerConnection)

    /*if (!relaying){
      

    }else {
      return
      // Relay received tracks from WHIP encoder to other peers
      sentStream = new MediaStream()
      users[0].peerConnection.getReceivers()
        .forEach(receiver => {
          let track = receiver.track
          console.log("adding realyed " + track.kind + " track " + track.id)
          //track.contentHint = "detail"
          //track.contentHint = "music" //The music contentHint will only be set for audio tracks, detail for video
          
          document.getElementById("stream2").srcObject = sentStream
          peer.peerConnection.addTrack(track, sentStream)
        })

    }*/
  })
}

async function createDataChannel(peerId, dataChannelLabel) {
  console.log('Creating new DataChannel for ' + peerId)
  const user = users[peerId]
  user.peerConnection ??= createPeerConnection(peerId)
  return user.peerConnection.createDataChannel(dataChannelLabel)
}

function configureCodecs(peerConnection) {
  const transceivers = peerConnection.getTransceivers()

  transceivers.forEach((transceiver) => {
    if (!transceiver.setCodecPreferences) return //Not supported on Firefox

    const kind = transceiver.sender.track.kind
    let sendCodecs = RTCRtpSender.getCapabilities(kind).codecs

    if (kind === "video") {
      // Search our preferred codec to set it on the position with most priority
      const index = sendCodecs.findIndex((codec) => {
        //return codec.sdpFmtpLine?.includes("42e01f") && !codec.sdpFmtpLine?.includes("packetization-mode=1")
        return codec.mimeType == "video/AV1"
      })

      sendCodecs.unshift(sendCodecs[index])
      //delete sendCodecs[index + 1]

      transceiver.setCodecPreferences(sendCodecs)
    }
  })
}

function createPeerConnection(peerId) {
    const peerConnection = new RTCPeerConnection(WebRTCConnectionConfig)

    peerConnection.peerId = peerId
    peerConnection.lastPort = []
    configureCodecs(peerConnection)

    peerConnection.addEventListener('negotiationneeded', handleNegotiationNeededEvent)
    peerConnection.addEventListener('icecandidate', handleICECandidateEvent)
    peerConnection.addEventListener('iceconnectionstatechange', handleICEConnectionStateChangeEvent)
    peerConnection.addEventListener('track', handleTrackEvent)
    peerConnection.addEventListener('datachannel', onRemoteDataChannel)
    
    return peerConnection
}


//----------- WebRTC SDP Negotiation -----------
async function handleNegotiationNeededEvent() {

  const offer = await this.createOffer()

  await this.setLocalDescription(offer)

  let sdp = this.localDescription //relaying ? users[0].peerConnection.remoteDescription : this.localDescription
  sendToServer({
    type: "video-offer",
    from: myId,
    to: this.peerId,
    sdp: sdp,
  })
}

/*function handleNegotiationNeededEvent2(peer) {
  peer
    .createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true })
    .then((offer) => peer.setLocalDescription(offer))
    .then(() => {
      //Wait for ICE candidates to be gathered, and send the offer that contains them
      setTimeout(() => {
        sendToServer({
          type: "video-offer",
          from: myId,
          to: peer.peerId,
          sdp: peer.localDescription,
        })
      }, 5000)
    })
    .catch(reportError)
}*/

async function handleVideoOfferMsg(msg) {
  const peer = users[msg.from]
  peer.peerConnection = createPeerConnection(msg.from)

  const desc = new RTCSessionDescription(msg.sdp)

  await peer.peerConnection.setRemoteDescription(desc)
  const answer = await peer.peerConnection.createAnswer()
  await peer.peerConnection.setLocalDescription(answer)

  const outgoingMsg = {
    type: "video-answer",
    from: myId,
    to: msg.from,
    sdp: peer.peerConnection.localDescription,
  }

  /*if (msg.from === 0) {
    // Wait for ICE candidates to be gathered, in case this is an offer from the WHIP encoder,
    // so they are included in the SDP message.
    // TODO: it's possible to indicate iceCandidatePoolSize on new RTCPeerConnection()
    // so it gathers candidates before generating the SDP offer
    setTimeout(() => {
      outgoingMsg["sdp"] = peer.peerConnection.localDescription
      sendToServer(outgoingMsg)
      streaming = true
    }, 4000)
  } else {
    sendToServer(outgoingMsg)
  }*/

  sendToServer(outgoingMsg)
}

function handleVideoAnswerMsg(msg) {
  const desc = new RTCSessionDescription(msg.sdp)
  const peer = users[msg.from]

  peer.peerConnection.setRemoteDescription(desc)
}

//----------- WebRTC ICE -----------
function handleICECandidateEvent(event) {
  if (event.candidate) {
    sendToServer({
      type: "new-ice-candidate",
      from: myId,
      to: this.peerId,
      candidate: event.candidate,
    })
  }
}

function natDebug(candidate, peer){
  let candidateSplitted = candidate.split(" ")
  if (candidateSplitted[7] == "srflx" && (streaming || seeding)){
    const port = parseInt(candidateSplitted[5])
    peer.peerConnection.lastPort.push(port)
  }
}

function handleNewICECandidateMsg(msg) {
  const peer = users[msg.from]

  natDebug(msg.candidate.candidate, peer)

  const candidateGenerator = portPrediction(msg.candidate.candidate)

  for (const genCandidate of candidateGenerator) {
    msg.candidate.candidate = genCandidate
    
    peer.peerConnection
      .addIceCandidate(new RTCIceCandidate(msg.candidate))
      .catch(reportError)
  }
}

function handleICEConnectionStateChangeEvent(event) {
  // Port prediction debugging
  if (streaming && this.iceConnectionState == "connected"){
    this.getSenders().forEach(sender => {
      const selectedPort = sender.transport.iceTransport.getSelectedCandidatePair().remote.port
      const portDiff = selectedPort - users[this.peerId].peerConnection.lastPort[0]
      console.log("Received ICE ports: " + users[this.peerId].peerConnection.lastPort)
      console.log("Active port: " + selectedPort + " Port Diff: " + portDiff)
    })
  }
}

//----------- WebRTC Stream events -----------
function handleTrackEvent(event) {
  //if (!relaying){
    console.log("received stream " + event.streams[0].id)
    localStream.srcObject = event.streams[0]
  /*} else {
    console.log("relaying stream " + event.streams[0].id)

    //sentStream = new MediaStream()

    Object.entries(users).forEach(([peerId, peer]) => {
      if (peerId == 0) return
      peer.peerConnection = createPeerConnection(peerId)
      console.log("configuring peer " + peerId)
      peer.peerConnection.addStream(event.streams[0])
      /*users[0].peerConnection.getReceivers()
        .forEach(receiver => {
          let track = receiver.track
          console.log("adding realyed " + track.kind + " track " + track.id)
          //track.contentHint = "detail"
          //track.contentHint = "music" //The music contentHint will only be set for audio tracks, detail for video
          
          document.getElementById("stream2").srcObject = sentStream
          peer.peerConnection.addTrack(track, sentStream)
      })*/
    /*})
  }*/
}

function onRemoteDataChannel(event) {
  event.channel.addEventListener('open', () => sendMedia(event.channel.label, event.channel))
}


//----------------------------------- Media acquisition -----------------------------------
const displayMediaOptions = {
  video: {
    //width: 1920,
    //heigh: 1080,
    //frameRate: 30
  },
  audio: {
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    sampleRate: 48000
  }
}

function getMediaStream(){
  return navigator.mediaDevices.getDisplayMedia(displayMediaOptions)
}


//----------------------------------- Video File Stream -----------------------------------
async function sendMedia(socketLabel, socket) {
  const [streamType, mediaUuid] = socketLabel.split('.')
  
  const playlistElement = playlist.find((element) => element.mediaUuid === mediaUuid)
  const player = playlistElement.player

  await player.streamLoading
  await player.sendStreams(socket, streamType)
}

async function receiveMedia(mediaUuid, player, ownerId) {
  const otherSocket = await createDataChannel(ownerId, `other.${mediaUuid}`)
  otherSocket.addEventListener('open', player.receiveStreams(otherSocket, 'other', updatePlayerControls))

  const videoSocket = await createDataChannel(ownerId, `video.${mediaUuid}`)
  videoSocket.addEventListener('open', player.receiveStreams(videoSocket, 'video'))
  
  const audioSocket = await createDataChannel(ownerId, `audio.${mediaUuid}`)
  audioSocket.addEventListener('open', player.receiveStreams(audioSocket, 'audio'))
}


//---------------------------------------- Util ----------------------------------------
// Generates candidates using predicted ports for peers behind Symmetric NATs
// that map ports to a different public port each time, independent from the open port
// on the browser's side.
function* portPrediction(candidate) {
  console.log('Original candidate ', candidate)
  let candidateSplitted = candidate.split(" ")

  if (candidateSplitted[7] == "srflx" && (streaming || seeding)){
    var port = parseInt(candidateSplitted[5])

    for (var i = -10; i <= 10; i++){
      candidateSplitted[5] = port + i
      console.log('Generated candidate', candidateSplitted.join(" "))
      yield candidateSplitted.join(" ")
    }

    return
  }
  
  yield candidate
}


/*/----------------------------------- WebTorrent -----------------------------------
var webTorrentClient

// Torrent peers, identified by their User ID. If we receive signaling data for a
// peer that hasn't still been initialized, it'll be saved in torrentPeer[id].pendingData
const torrentPeers = {}

async function getWTClient(){
  if (!webTorrentClient){
    const {default: WebTorrent} = await import('./webtorrent.min.js')
    const wtOptions = {
      tracker: false
    }
    webTorrentClient = new WebTorrent(wtOptions)
  }

  return webTorrentClient
}

async function configureTorrentPeers(initiator, peers) {
  // Configure peers with simple-peer
  if (typeof SimplePeer === 'undefined') await import('./simplepeer.min.js')
  
  console.log('Configure peers: ', peers)
  
  const configuredPeers = []

  peers.forEach(peerId => {
    if (torrentPeers[peerId]?.writable !== undefined) return

    const newPeer = new SimplePeer({ initiator: initiator, trickle: true })

    newPeer.on('signal', data => {
      sendToServer({
        type:"torrent-signal",
        to: peerId,
        from: myId,
        data: data
      })
    })

    const pendingData = torrentPeers[peerId]?.pendingData
    torrentPeers[peerId] = newPeer

    if (pendingData !== undefined){
      // We received signaling info before the peer was initialized. Process it now
      pendingData.forEach(data => newPeer.signal(data))
    }
    
    configuredPeers.push(newPeer)
    console.log("Configured torrent peer " + peerId)
  })

  return configuredPeers
}

async function seedPrivateTorrent(files) {
  const wTClient = await getWTClient()
  const wasSeeding = seeding

  const onTorrent = async torrent => { 
    console.log('Torrent created ' + torrent.magnetURI)
    
    sendToServer({
      type:"torrent",
      from: myId,
      magnet: torrent.magnetURI,
    })

    seeding = true

    configureTorrentPeers(true, Object.keys(users))
      .then(connectedPeers => {
        connectedPeers.forEach(simplePeer => {
          torrent.addPeer(simplePeer)
        })
      })
  }

  // Will be executed only when a new torrent is added.
  // Saves time compared with using the onSeed callback.
  wTClient.on('torrent', onTorrent)

  wTClient.seed(files, {announceList: []}, torrent => {
    // onSeed runs for new and duplicated torrents. Reconfigure peers only when
    // we were already seeding, because onTorrent wasn't called in that case.
    // This lets us configure users that joined while seeding.
    if (wasSeeding) onTorrent(torrent)
  })
}

async function receiveTorrent(magnet, peerId) {
  const wTClient = await getWTClient()

  async function download () {
    console.log("Adding torrent for download: " + magnet)
    // const skipVerify = !!await wTClient.get(magnet) Can't check if torrent is in cache. 
    const torrent = wTClient.add(magnet, {skipVerify: false, strategy: 'sequential'}, async torrent => {
      // Torrents can contain many files. Let's use the .mp4 file
      const file = torrent.files[0] //.find(file => file.name.endsWith('.mp4'))
      
      // Stream to a <video> element by providing an the DOM element
      //file.streamTo(localStream)
      console.log('Ready to play!')

      const player = new Player(await file.blob(), localStream, true)
      await player.initialize()
      await player.loadStreams()
    })

    configureTorrentPeers(false, [peerId])
      .then(peers => {
        torrent.addPeer(peers[0])
      })
  }

  download()
  /*navigator.serviceWorker.register('./sw.min.js', { scope: './' }).then(reg => {
    const worker = reg.active || reg.waiting || reg.installing
    function checkState (worker) {
      console.log('ServiceWorker state: ' + worker.state)
      return worker.state === 'activated' && wTClient.createServer({ controller: reg }) && download()
    }
    if (!checkState(worker)) {
      worker.addEventListener('statechange', ({ target }) => checkState(target))
    }
  })*/
/*}

async function applyReceivedSignal(peer, data) {
  // Intercepts signal data so we can apply port prediction to simple-peer candidates
  if (data.type == 'candidate') {
    const candidateGenerator = portPrediction(data.candidate.candidate)
    for (const candidate of candidateGenerator) {
      data.candidate.candidate = candidate
      peer.signal(data)
    }
  } else {
    peer.signal(data)
  }
}

async function receivedTorrentSignal(peerId, data) {
  if (torrentPeers[peerId]?.signal !== undefined) {
    applyReceivedSignal(torrentPeers[peerId], data)
  // Otherwise, peer still isn't initialized. Save data in pendingData
  } else if (torrentPeers[peerId]?.pendingData !== undefined) {
    torrentPeers[peerId].pendingData.push(data)
  } else {
    torrentPeers[peerId] = {pendingData: [data]}
  }
}*/