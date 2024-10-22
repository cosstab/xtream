# xtream
A place to watch videos with friends, without loss of quality. Just share your link and drop a video file!

[Try it out](https://xtream.chabal.es)

## Status
The project is still under heavy development. Expect lots of bugs.

## Features
- Video files are transferred without quality loss.
- .mkv video support.
- Each user can choose their preferred audio and subtitle language.
- Share your screen (browsers' screen capture is quite lossy, expect Discord-like video quality).
- Convenient text chat.

## How does it work?
The videos you drop are shared with your friends in a peer-to-peer manner, using WebRTC data channels. The files are encrypted from end to end and they don't go through our server.
Depending on the Internet provider, some users can't connect to others. This is often due to CG-NAT, and it happens more on cellular connections. I'm working to fix that.
