import { FFmpeg } from "./ffmpeg/ffmpeg-0.12.7/package/dist/esm/index.js"
import { fetchFile } from "./ffmpeg/util-0.12.1/package/dist/esm/index.js"

export default class Player {
  constructor (videoElement, metadata, minSecondsBufferedAhead=30, url=false){
    this.videoElement = videoElement
    this.metadata = metadata
    this.minSecondsBufferedAhead = minSecondsBufferedAhead
    this.url = url

    this.videoStreams = null
    this.audioStreams = []
    this.subtitleStreams = []

    this.mediaSource = null

    this.vStreamLoader = null
    this.aStreamLoader = null

    // Promise that will be resolved when streams can be appended
    this.streamLoading = new Promise((resolve) => this._resolveStreamLoading = resolve)
  }

  // We'll call this function when the playing audio and video streams are fully loaded
  _onStreamLoaded = () => {
    if (this.vStreamLoader.lastSegmentLoaded && this.aStreamLoader.lastSegmentLoaded)
      this.mediaSource.endOfStream()
  }

  async initialize() {
    console.log("Initializing Player")
    console.log ('Video streams: ', await this.listStreams("video"))
    console.log ('Audio streams: ', await this.listStreams("audio"))
    console.log ('Subtitle streams: ', await this.listStreams("subtitle"))

    //this.videoElement.addEventListener('timeupdate', this.onTimeUpdate)
    this.streamLoading.then(() => {
      setInterval(() => {
        Promise.all([
          this.aStreamLoader?.bufferFromTimestamp(this.videoElement.currentTime),
          this.vStreamLoader?.bufferFromTimestamp(this.videoElement.currentTime)
        ])
      }, 500) //TODO: clearInterval() after detach()?
    })

    this.mediaSource = new MediaSource()
    this.videoElement.src = URL.createObjectURL(this.mediaSource)
    await waitForEvent(this.mediaSource, 'sourceopen')
    this.mediaSource.addEventListener('sourceended', () => {console.error('sourceended')})
    this.mediaSource.addEventListener('sourceclose', () => {console.error('sourceclose')})
    if (this.metadata) this.mediaSource.duration = this.metadata.duration

    // The first segments of audio and video need to be provided at the same time to the
    // video element. For example, if audio is provided some time after appending the first video segment,
    // the video player will play the video with no audio.
    //
    // To overcome this, the first stream to get ready will create a promise, and save the resolve
    // function into this object. The second stream to get ready will append its first segment, and
    // resolve the promise, that the first stream was awaiting, so it can append its first segment right after that.
    const audioAndVideoReady = { resolve: null }
    this.vStreamLoader = new StreamLoader(this.mediaSource, audioAndVideoReady, this._onStreamLoaded, this.minSecondsBufferedAhead)
    this.aStreamLoader = new StreamLoader(this.mediaSource, audioAndVideoReady, this._onStreamLoaded, this.minSecondsBufferedAhead)

    console.log('Player initialized')
  }

  async initializeFfmpeg() {
    console.log("Initializing FFmpeg")
    this.ffmpeg = new FFmpeg()

    this.ffmpeg.on("log", ({ message }) => {
      console.debug(message)
    })

    this.ffmpeg.on("progress", ({ progress }) => {
      console.log(progress)
      // Show progress on seek bar
      this.videoElement.currentTime = this.videoElement.duration * progress
    })

    await this.ffmpeg.load({
      coreURL: "../../../../../ffmpeg/core-0.12.4/package/dist/esm/ffmpeg-core.js",
    })
  }

  async listStreams(filter=null) {
    if (filter === null) return this.metadata.flat()
    else {
      let response = []
      for (const stream of this.metadata.streams)
        for (const subStream of stream)
          if (subStream.type === filter) 
            response.push(subStream)
      
      return response
    }
  }

  async getSubtitles() {
    const urlList = []
    for (const {stream, meta} of this.subtitleStreams) {
      const blob = new Blob([stream], { type: 'text/vtt' })
      const url = URL.createObjectURL(blob)
      urlList.push({meta, url})
    }

    return urlList
  }

  async selectAudioTrack(audioTrackIdx) {
    await this.aStreamLoader.bufferFromTimestamp(this.videoElement.currentTime, 
                                                this.audioStreams[audioTrackIdx])
  }

  detach(){
    // Maybe terminate all ffmpeg stuff here
    // Maybe some error can occur when detach is called while StreamLoader is working
    //this.videoElement.removeEventListener('timeupdate', this.onTimeUpdate)
  }
}

// Contains the necessary logic to transmux/transcode a video file and segment it so it can
// be read by MSE.
export class FilePlayer extends Player {
  constructor(videoElement, file, minSecondsBufferedAhead, segmentTime=10) {
    super(videoElement, undefined, minSecondsBufferedAhead)

    this.file = file
    this.segmentTime = segmentTime

    this.fileName = null
  }

  async parseMetadata() {
    if (!this.ffmpeg) await this.initializeFfmpeg()

    console.log("Parsing Metadata")

    const parser = new FFmpegMetaParser()
    const parseLine = ({message}) => parser.parseFfmpegLine(message)

    //let fullLog = ''
    //const debugLog = ({message}) => fullLog += message + '\n'
    //this.ffmpeg.on("log", debugLog)

    this.ffmpeg.on("log", parseLine)

    if(this.url) this.fileName = 'aaaa.mkv'
    else this.fileName = this.file.name
    await this.ffmpeg.writeFile(this.fileName, await fetchFile(this.file))

    //delete this.file //Remove reference so garbage collector removes the file from memory 

    await this.ffmpeg.exec(['-hide_banner', '-i', this.fileName])

    this.ffmpeg.off('log', parseLine)

    //this.ffmpeg.off("log", debugLog)
    //console.log(fullLog)
    //console.log(parser.ffmpegMetadata)
    this.metadata = parser.ffmpegMetadata[0]
  }

  async listStreams(filter=null) {
    if (!this.metadata) await this.parseMetadata()

    return super.listStreams(filter)
  }

  codecLookupTable = {
    av1: {
      transcode: false,
      codecs: 'codecs="av01.0.13M.10"', //Main LVL5.1(3840×2160@60fps) Tier:Main(?) 10bits
      extension: 'mp4'
    },
    vp9: {
      transcode: false,
      codecs: 'codecs="vp9"',
      extension: 'webm'
    },
    vp8: {
      transcode: false,
      codecs: 'codecs="vp8"',
      extension: 'webm'
    },
    h264: {
      transcode: false,
      codecs: 'codecs="avc1.4d0034"',
      extension: 'mp4'
    },
    hevc: {
      transcode: false,
      codecs: 'codecs="hev1.1.6.L120.90"',
      extension: 'mp4'
    },
    opus: {
      transcode: false,
      codecs: 'codecs="opus"',
      extension: 'mp4'
    },
    /*flac: {
      // -strict experimental isn't working on ffmpeg wasm for fragmented mp4, apparently. We need to transcode
      transcode: false,
      codecs: 'codecs="flac"',
      extension: 'mp4'
    },*/
    aac: {
      transcode: false,
      codecs: 'codecs="mp4a.40.2"',
      extension: 'mp4'
    },
    vorbis: {
      transcode: false,
      codecs: 'codecs="vorbis"',
      extension: 'webm'
    }
  }

  getMSECompatibleConfig(stream) {
    let inputCodec = stream.codec.split(' ')[0]
    let config = this.codecLookupTable[inputCodec]
    
    if (config === undefined) {

      switch (stream.type) {
        case 'video':
          config = {
            transcode: true,
            ffCodecLib: 'libvpx',
            codecs: 'codecs="vp8"',
            extension: 'webm'
          }
          break
        case 'audio':
          config = {
            transcode: true,
            ffCodecLib: 'libvorbis', //'libopus',
            codecs: 'codecs="vorbis"', //"opus"',
            extension: 'webm'
          }
          break
        case 'subtitle':
          config = {
            transcode: true,
            ffCodecLib: 'webvtt',
            codecs: '',
            extension: 'vtt'
          }
          break
      }
    }

    return {...config, mimeType: stream.type + '/' + config.extension}
  }

  async extractStreams(streams, segmented=false) {
    const ffmpegArgs = ['-i', this.fileName]
    // Output file name will be like 0_0_00000.webm, last group of numbers is a counter for each segment of a stream
    const fileName = (stream, subStream, extension) => {return `${stream}_${subStream}_%05d.${extension}`}

    // Add arguments to FFmpeg so we can extract each substream
    for (const stream of streams){
      const config = this.getMSECompatibleConfig(stream)
      let {transcode, extension, ffCodecLib} = config

      const name = fileName(stream.streamIdx, stream.subStreamIdx, extension)
      console.log('Adding task to FFmpeg: ' + name)

      // Each specified video/audio stream will be extracted individually
      ffmpegArgs.push('-map', `${stream.streamIdx}:${stream.subStreamIdx}`) //, '-strict', 'experimental')

      if (!transcode) ffmpegArgs.push('-c', 'copy')
      else ffmpegArgs.push('-c', ffCodecLib, '-crf', '60', '-deadline', 'realtime', '-cpu-used', '8')
      
      if (segmented){
        // Output wil be divided in segments of around segmentTime seconds.
        // A .csv list will be created with each stream's duration.
        ffmpegArgs.push('-f', 'segment', '-segment_time', this.segmentTime.toString(), '-segment_time_delta', '1', '-segment_list', `${name}.csv`)
        if (extension === 'mp4')
          ffmpegArgs.push('-segment_format_options', 'movflags=frag_keyframe+empty_moov+default_base_moof')
      }

      ffmpegArgs.push(name) //Finally, append the output file's name
    }

    // Start extraction/conversion of streams
    console.log(ffmpegArgs)
    await this.ffmpeg.exec(ffmpegArgs) 

    const files = []
    const segmentReaders = []
    for (const stream of streams){
      console.log(stream)
      let config = this.getMSECompatibleConfig(stream)
      const name = fileName(stream.streamIdx, stream.subStreamIdx, config.extension)

      if (segmented) {
        const segmentReader = new SegmentReader(this.ffmpeg, name, config)
        await segmentReader.initialize()
        segmentReaders.push(segmentReader)
      }
      else files.push({
        stream: await this.ffmpeg.readFile(name),
        config,
        meta: stream
      })
    }

    console.log((files.length) ? files : segmentReaders)
    return (files.length) ? files : segmentReaders
  }

  async loadStreams() {
    console.log('Extracting streams')
    await Promise.all([
      new Promise(async (resolve) => {
        const videoStreams = await this.listStreams('video')
        this.videoStreams = await this.extractStreams(videoStreams, true)
        resolve()
      }),
      new Promise(async (resolve) => {
        const audioStreams = await this.listStreams('audio')
        this.audioStreams = await this.extractStreams(audioStreams, true)
        resolve()
      }),
      new Promise(async (resolve) => {
        const subtitleStreams = await this.listStreams('subtitle')
        this.subtitleStreams = await this.extractStreams(subtitleStreams)
        resolve()
      })
    ])

    this.videoElement.currentTime = 0 //Reset time (we used the seek bar to show progress when loading)

    this.ffmpeg.deleteFile(this.fileName)

    console.log('Buffering streams')
    this.vStreamLoader.bufferUntilFull(this.videoStreams[0])
    this.aStreamLoader.bufferUntilFull(this.audioStreams[0])

    console.log('Streams are loading')
    // Maybe ffmpeg.terminate() and delete this.file here

    this._resolveStreamLoading()
  }
}

const WEBRTC_MAX_MESSAGE_SIZE = 256*1024 //256KiB

// Sends streams over a socket connection so this player can be instantiated on other device
export class StreamableFilePlayer extends FilePlayer {
  async sendStreams(socket, streamType) {
    console.log('Sending ' + streamType + ' stream')
    var streams
    switch (streamType) {
      case 'video':
        streams = this.videoStreams
        break
      case 'audio':
        streams = this.audioStreams
        break
      case 'other':
        for (const subtitle of this.subtitleStreams) {
          socket.bufferedAmountLowThreshold = 1
          console.debug('Sending subtitle meta', subtitle.config, subtitle.meta)
          socket.send(JSON.stringify({
            config: subtitle.config,
            meta: subtitle.meta
          }))
          await waitForEvent(socket, 'bufferedamountlow')

          console.debug('Sending subtitle stream', subtitle.stream)
          var length = subtitle.stream.byteLength
          for (var i=0; i<length; i+=WEBRTC_MAX_MESSAGE_SIZE) {
            socket.send(subtitle.stream.slice(i, WEBRTC_MAX_MESSAGE_SIZE+i))
            // Wait for socket buffer to empty, or other messages will be sent out of order
            await waitForEvent(socket, 'bufferedamountlow')
          }
        }

        return
    }
  
    socket.addEventListener('message', async (ev) => {
      const {streamIdx, segmentIdx} = JSON.parse(ev.data)
      const requestedSegment = await streams[streamIdx].read(segmentIdx)

      console.debug(`Sending segment ${segmentIdx} from ${streamType} stream #${streamIdx}`, streams[streamIdx].segments.length)

      var length = requestedSegment.stream.length
      for (var i=0; i<length; i+=WEBRTC_MAX_MESSAGE_SIZE) {
        socket.send(requestedSegment.stream.slice(i, WEBRTC_MAX_MESSAGE_SIZE+i))
      }
    })

    const meta = []
    for (let stream of streams) {
      meta.push({
        config: await stream.config,
        segments: stream.segments
      })
    }
    
    socket.send(JSON.stringify(meta))
  }
}

export class StreamPlayer extends Player {
  // Receives streams from another player trough a socket connection
  async receiveStreams(socket, streamType, callback) {
    console.log('New Stream: ' + streamType)

    socket.binaryType = 'arraybuffer'

    switch (streamType) {
      case 'video':
        // Readers of the same socket will share a promise to wait for an ongoing transfer to end
        var receiving = { promise: Promise.resolve() }

        console.log('Creating video reader')
        const segmentReader = new SegmentReaderFromSocket(socket, 0, receiving)
        //this.vStreamLoader.bufferUntilFull(segmentReader)
        //this.vStreamLoader.bufferFromTimestamp(this.videoElement.currentTime, segmentReader)
        this.vStreamLoader.initializeSourceBuffer(segmentReader)
        break
      case 'audio':
        // Readers of the same socket will share a promise to wait for an ongoing transfer to end
        var receiving = { promise: Promise.resolve() }

        const streamNumber = (await this.listStreams('audio')).length
        for (var i=0; i < streamNumber; i++) {
          console.log('Creating audio reader', i)
          this.audioStreams[i] = new SegmentReaderFromSocket(socket, i, receiving)
        }
        
        //this.aStreamLoader.bufferUntilFull(this.audioStreams[0])
        //this.aStreamLoader.bufferFromTimestamp(this.videoElement.currentTime, this.audioStreams[0])
        this.aStreamLoader.initializeSourceBuffer(this.audioStreams[0])
        break
      case 'other':
        socket.addEventListener('message', (ev) => {
          for (var i=0; i<=this.subtitleStreams.length; i++){
            if (this.subtitleStreams[i]?.config === undefined) {
              console.debug('Received subtitle meta', ev.data, socket.ordered)
              const {config, meta} = JSON.parse(ev.data)
              this.subtitleStreams[i] = {
                config,
                meta
              }
              break
            } else if (this.subtitleStreams[i]?.stream === undefined) {
              console.debug('Received subtitle stream part', ev.data)
              this.subtitleStreams[i].streamTemp ??= []
              this.subtitleStreams[i].streamTemp.push(ev.data)

              if (ev.data.byteLength < WEBRTC_MAX_MESSAGE_SIZE){
                console.debug('Subtitle download completed')
                this.subtitleStreams[i].stream = new Blob(this.subtitleStreams[i].streamTemp, { type: 'text/vtt'})
                //this.subtitleStreams[i].stream = ev.data.slice(0, ev.data.size, 'text/vtt') //Set blob type. May not work on Safari https://stackoverflow.com/questions/18998543/set-content-type-on-blob#comment115879337_50875615
                callback()
              }
              
              break
            }
          }
        })
        break
    }

    // TODO: promise won't be resolved when the media has no audio or video streams
    if (this.vStreamLoader.segmentReader && this.aStreamLoader.segmentReader) this._resolveStreamLoading()
  }
}

class SegmentReader { //Extracts each segment of a substream, on demand
  constructor(ffmpeg, name, config) {
    this.ffmpeg = ffmpeg
    this.name = name
    this.config = Promise.resolve(config)
    
    this.cache = []
  }

  async initialize() {
    console.log('Initializing SegmentReader for file: ' + this.name)
    this.segments = (await this.ffmpeg.readFile(`${this.name}.csv`, 'utf8')).split('\n').slice(0, -1)
  }

  async read(idx) {    
    if (this.cache[idx]) return this.cache[idx]

    const segmentInfo = this.segments[idx]
    if (segmentInfo === undefined) return
    const [segmentName, start, end] = segmentInfo.split(',')

    console.log('Reading ' + segmentName)
    const data = await this.ffmpeg.readFile(segmentName)
    this.ffmpeg.deleteFile(segmentName)

    const segment = {
      stream: data,
      start,
      end
    }

    this.cache[idx] = segment
    return segment
  }
}

class SegmentReaderFromSocket {
  constructor (socket, streamIdx, receiving) {
    this.socket = socket
    this.streamIdx = streamIdx
    this.receiving = receiving

    this._configReceived = null
    this.config = new Promise((resolve) => this._configReceived = resolve)

    this.cache = []

    this.socket.addEventListener('message', (ev) => {
      // First received message will contain metadata of all the streams of the same kind (audio or video)
      const meta = JSON.parse(ev.data)[streamIdx]
      console.log('Received metadata', meta)

      this._configReceived(meta.config)
      this.segments = meta.segments
    }, { once: true })
  }

  async read(segmentIdx) {
    if (this.cache[segmentIdx]) return this.cache[segmentIdx]
    if (this.segments === undefined) await waitForEvent(this.socket, 'message') //Wait for metadata
    await this.receiving.promise //Wait for other readers using this socket to end receiving

    const segmentInfo = this.segments[segmentIdx]
    if (segmentInfo === undefined) return
    const [_, start, end] = segmentInfo.split(',')

    return this.receiving.promise = new Promise((resolve) => {
      const segment = {
        stream: [],
        start,
        end
      }

      const receive = async (ev) => {
        console.debug('Received segment ' + segmentIdx, ev.data)
        segment.stream.push(ev.data)

        if (ev.data.byteLength < WEBRTC_MAX_MESSAGE_SIZE){
          segment.stream = await (new Blob(segment.stream)).arrayBuffer()
          
          this.cache[segmentIdx] = segment
          this.socket.removeEventListener('message', receive)
          resolve(segment)
        }
      }
      // Configure listener to solve the promise with the data received on the next message
      this.socket.addEventListener('message', receive)

      // Request segment to the media owner
      this.socket.send(JSON.stringify({
        streamIdx: this.streamIdx,
        segmentIdx
      }))
      console.debug('Segment ' + segmentIdx + ' requested.', segmentInfo, this.segments.length)
    })
  }
}

class StreamLoader {
  constructor(mediaSource, audioAndVideoReady, onStreamLoaded, minSecondsBufferedAhead){
    this.mediaSource = mediaSource
    this.audioAndVideoReady = audioAndVideoReady
    this.onStreamLoaded = onStreamLoaded
    this.minSecondsBufferedAhead = minSecondsBufferedAhead
    this.segmentReader = null
    this.sourceBuffer = null
    this.nextSegment = 0
    this.buffering = false
    this.lastSegmentLoaded = true
    this.loadedPromiseResolve = null
    this.loadedPromise = new Promise(resolve => this.loadedPromiseResolve = resolve)
  }

  async initializeSourceBuffer(segmentReader) {
    this.segmentReader ??= segmentReader
    const config = await this.segmentReader.config
    let mimeType = `${config.mimeType};${config.codecs}`
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType)
    console.log(mimeType)
    this.sourceBuffer.mode = 'sequence'
  }

  async bufferUntilFull(segmentReader) {
    if (!this.segmentReader && !segmentReader) return

    this.buffering = true
    
    if (!this.sourceBuffer) this.initializeSourceBuffer(segmentReader)
    else if (segmentReader) this.segmentReader = segmentReader

    this.lastSegmentLoaded = false
    var currentSegment = await this.segmentReader.read(this.nextSegment)

    const appendNextSegment = async () => {
      this.listTimeBuffers()

      currentSegment = await this.segmentReader.read(this.nextSegment)
      if (currentSegment) {
        if (this.sourceBuffer.updating) await waitForEvent(this.sourceBuffer, 'updateend')

        console.debug('Append segment ', currentSegment.stream, currentSegment.start, currentSegment.end)
        try {
          this.sourceBuffer.appendBuffer(currentSegment.stream)
        } catch (e) {
          console.log('Buffer full, buffering suspended')
          this.sourceBuffer.removeEventListener('updateend', appendNextSegment)
          this.buffering = false
          return
        }
        console.debug('Segment ' + this.nextSegment + ' appended')
        this.nextSegment++

      } else {
        this.lastSegmentLoaded = true
        console.log('Full stream was loaded')
        this.sourceBuffer.removeEventListener('updateend', appendNextSegment)
        this.buffering = false

        // Run callback so mediaSource.endOfStream() can be called when necessary
        this.onStreamLoaded()
      }
    }
    
    if (this.sourceBuffer.updating) await waitForEvent(this.sourceBuffer, 'updateend')
    this.sourceBuffer.timestampOffset = parseFloat(currentSegment.start)
    this.sourceBuffer.addEventListener('updateend', appendNextSegment)

    // Solve promise if it's defined, or create one to wait for the other stream to get ready,
    // so we append both streams at the same time
    if (this.audioAndVideoReady.resolve) this.audioAndVideoReady.resolve()
    else {
      await new Promise((resolve) => this.audioAndVideoReady.resolve = resolve)
    }

    appendNextSegment()

    return this.loadedPromise
  }

  needsBuffering(time) {
    if (time >= this.mediaSource.duration) return !this.lastSegmentLoaded

    const buffered = this.sourceBuffer.buffered
    for (var i=0; i < buffered.length; i++) {
      if ((buffered.start(i) <= time) && (time <= buffered.end(i))){
        return false
      }
    }

    return true
  }

  async bufferFromTimestamp(time, newSegmentReader=undefined) {
    if (this.buffering) return

    if (newSegmentReader) {
      // Update the SegmentReader when a different audio track is requested
      this.segmentReader = newSegmentReader
      if (!this.sourceBuffer) await this.initializeSourceBuffer()

    } else if (!this.segmentReader || 
                (!this.needsBuffering(time) && !this.needsBuffering(time+this.minSecondsBufferedAhead))) {

      return
    }

    this.buffering = true

    // Tried to remove only necessary segments, but browsers delete buffered data randomly, and we can't
    // trust browser's buffer timestamps to know which segments are loaded, since they differ from FFmpeg
    // segment timestamps. Entirely clearing and loading the buffer each time is fast enough so...
    this.sourceBuffer.remove(0, Infinity)

    var i
    for (i=0; i<this.segmentReader.segments.length; i++) {
      let segmentInfo = this.segmentReader.segments[i]
      const [segmentName, start, end] = segmentInfo.split(',')
      
      if ((start <= time) && (time <= end)) {
        console.debug('Chosen segment:', segmentName, start, time, end)
        // When we find the segment that contains the timestamp, we load the previous segment, in case
        // there's some discrepancy between the FFmpeg timestamp and where the browser places the segment.
        this.nextSegment = (i == 0) ? i : i-1

        return await this.bufferUntilFull()
      }
    }

    // Load last segment in case the timestamp wasn't found (innaccurate segment duration)
    this.nextSegment = i - 1
    return await this.bufferUntilFull()
  }

  listTimeBuffers() {
    var l = this.sourceBuffer.buffered.length - 1
    for (; l >= 0; l--){
      console.debug(this.sourceBuffer.buffered.start(l), this.sourceBuffer.buffered.end(l))
    }
  }
}

class FFmpegMetaParser {
  constructor() {
    this.ffmpegMetadata = []
    this.stack = [] //Helper stack to keep track of the current path
  }

  parseFfmpegLine(line) {
    // Search for new input, stream, metadata or chapter nodes and add them to the parent node
    let match = line.match(/^(?<indentation>\s*)(?<node>Input|Stream|Metadata|Chapters|Chapter|Duration)/)
    if (match){
      let {indentation, node} = match.groups
      const indentationLv = indentation.length / 2
      node = node.toLowerCase()

      let newNode = {}

      let parentNode
      if (this.stack.length > 0)  {
        for (var i = this.stack.length-indentationLv; i > 0; i--) this.stack.pop()
        parentNode = this.stack.at(-1)
      }

      console.log(node)
      console.log(parentNode)

      switch (node) {
        case 'input':
          this.ffmpegMetadata.push(newNode)
          break
        case 'stream':
          if (parentNode.streams === undefined) parentNode.streams = []
          newNode = this._parseStream(line)
          if (parentNode.streams[newNode.streamIdx] === undefined) parentNode.streams[newNode.streamIdx] = []
          parentNode.streams[newNode.streamIdx][newNode.subStreamIdx] = newNode
          break
        case 'metadata':
          parentNode.metadata = newNode
          break
        case 'chapters':
          newNode = parentNode.chapters = []
          break
        case 'chapter':
          parentNode.push(newNode)
          break
        case 'duration':
          const match = line.match(/Duration: (?<duration>\S+), start: (?<start>\S+), bitrate: (?<bitrate>\d+) kb\/s/)
          let {duration, start, bitrate} = match.groups
          duration = duration.split(':')
          
          parentNode.duration = duration[0]*3600 + duration[1]*60 + parseFloat(duration[2])
          parentNode.start = parseFloat(start)
          parentNode.bitrate = parseInt(bitrate)
          break
      }

      Object.defineProperty(newNode, "_nodeType", {
        enumerable: false,
        value: node
      });
      Object.defineProperty(newNode, "_ffmpegLine", {
        enumerable: false,
        value: line.slice(indentation.length)
      });

      this.stack.push(newNode)
      return
    }

    // Read metadata properties when we're inside a metadata node
    if (this.stack.at(-1)?._nodeType === 'metadata') {
      const indentationLv = line.search(/\S/) / 2;
      if (indentationLv === this.stack.length) {
        let {property, value} = line.match(/(?<property>\S*)\s*: (?<value>.*)/).groups
        this.stack.at(-1)[property] = value
      } else this.stack.pop();
    }
  }
  
  _parseStream(ffmpegLine) {
    let {streamIdx, subStreamIdx, language, type, properties, isDefault} = 
      ffmpegLine
        .match(/Stream #(?<streamIdx>\d+):(?<subStreamIdx>\d+)(?:\[.*\])?(?:\((?<language>.+?)\))?: (?<type>\S+): (?<properties>.+?)(?<isDefault> \(default\))?$/)
        .groups
    
    type = type.toLowerCase()

    // Split properties ignoring commas between parenthesis
    const otherProperties = []
    let i = properties.length
    let lastCut = i
    let wrappingParenthesis = 0
    while (i--) {
      switch (properties[i]){
        case ',':
          if (!wrappingParenthesis) {
            otherProperties.unshift(properties.slice(i+2, lastCut))
            lastCut = i
          }
          break
        case ')':
          wrappingParenthesis++
          break
        case '(':
          wrappingParenthesis--
          break
      }
    }

    otherProperties.unshift(properties.slice(0, lastCut))
    
    const codec = otherProperties.shift()
    isDefault = !!isDefault

    return {
      streamIdx,
      subStreamIdx,
      language,
      type,
      codec,
      isDefault,
      otherProperties
    }
  }
}

function waitForEvent(target, event) {
  return new Promise(res => {
    target.addEventListener(event, res, { once: true });
  });
}
