# xtream
A place to watch videos with friends, without loss of quality. Just share your link and drop a video file!

[Try it out](https://xtream.chabal.es)

## Demos
This is not screen sharing!

### Testing on different devices
https://github.com/user-attachments/assets/ca858ba5-b6a0-4496-b796-a71ebed08351

### Testing subtitles and audio tracks
https://github.com/user-attachments/assets/2c16682b-54cc-4bd8-af70-f4880c51fbfe

## Status
The project is still under heavy development. Expect lots of bugs.

## How does it work?
The videos you drop are shared with your friends in a peer-to-peer manner, using WebRTC data channels. The files are encrypted from end to end and they don't go through our server.

It splits the videos in small chunks using FFmpeg.wasm, so the receiver doesn't need to download the entire video to start watching.

## Features
- Video files are transferred without quality loss.
- Each user can choose their preferred audio and subtitle language.
- Share your screen (browsers' screen capture is quite lossy, expect Discord-like video quality).
- Convenient text chat.

Supported video formats: mp4, mkv, webm, mov.

Supported video codecs:
- h264 -> works pretty much anywhere, most devices have h264 hardware acceleration.
- AV1 -> much better quality for the same space. Royalty-free codec, works on most newer devices. Can drain the battery faster than h264 on mobile devices. It usually takes more time to encode.
- VP8, VP9 -> widely supported by browsers, but there's usually no reason to use them instead of h264 or AV1.
- Don't use h265/HEVC, it only works on certain compatible browsers running on devices with hardware support (or with the non-free Windows HEVC extension).

## Future features
- Full .ass subtitle support. At the moment, subtitles are converted to WebVTT, which can cause unexpected behaviors.
- Voice chat.
- Mesh networking to distribute the load across everybody in the same room (right now, the uploader of the file sends it to everyone, so we depend on their upload speed).
- TURN server for networks with restrictive NATs.
- File share.
- OBS WebRTC support (I've already been experimenting with this, it wouldn't be hard to add).
- P2P radio?

## Known issues
- Sometimes the video isn't loaded on the receiver side, it's usually fixed by refreshing the page.
- Depending on the Internet provider, some users can't connect to others. This is often due to CG-NAT, and it happens more on cellular connections. I'm working to fix that.
