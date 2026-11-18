import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { uploadFile } from '../api/client.js'
import { synthesize, transcribe, TTS_SAMPLE_RATE } from '../api/speech.js'
import { describeReply } from '../chat/describe.js'
import { getReplyText } from '../chat/reply.js'
import { sendVoicePrompt, stopReply, useChatStore } from '../chat/store.js'
import type { AssistantMessage } from '../chat/types.js'
import { matchesRefusalKeyword, useSettings } from '../settings.js'
import {
  describeReadAloudError,
  scheduleTtsStream,
  setReadAloudBlocked,
  stopReadAloud,
} from './readAloud.js'
import { encodeWav, MAX_SECONDS, SAMPLE_RATE } from './recorder.js'

export type VoiceCallPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'error'

type VoiceCallState = {
  active: boolean
  sessionId: string | null
  phase: VoiceCallPhase
  muted: boolean
  cameraEnabled: boolean
  cameraPending: boolean
  facingMode: 'user' | 'environment'
  videoStream: MediaStream | null
  speechDetected: boolean
  level: number
  userText: string
  assistantText: string
  error: TranslationMessage | string | null
}

export const useVoiceCall = create<VoiceCallState>(() => ({
  active: false,
  sessionId: null,
  phase: 'idle',
  muted: false,
  cameraEnabled: false,
  cameraPending: false,
  facingMode: 'environment',
  videoStream: null,
  speechDetected: false,
  level: 0,
  userText: '',
  assistantText: '',
  error: null,
}))

const FRAME_SIZE = 2048
const PRE_ROLL_FRAMES = 3
const SPEECH_START_FRAMES = 2
const SILENCE_END_FRAMES = 9
const MIN_SPEECH_FRAMES = 3
const SPEECH_RMS_THRESHOLD = 0.018
const SILENCE_RMS_THRESHOLD = 0.012
const MAX_CAPTURE_FRAMES = Math.floor((MAX_SECONDS * SAMPLE_RATE) / FRAME_SIZE)
const TTS_START_DELAY = 0.06
const SENTENCE_END_RE = /[。！？.!?\n]/

const computeRms = (samples: Float32Array) => {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

const cleanSpeechText = (text: string) =>
  text
    .replace(/[*_`#>~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()

const describeMicError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

const describeCameraError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceCallCameraPermissionDenied' }
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return { key: 'voiceCallCameraNoDevice' }
    }
  }
  return { key: 'voiceCallCameraFailed' }
}

const MAX_VIDEO_FRAME_EDGE = 768
let previewVideoEl: HTMLVideoElement | null = null

export const setVoiceCallVideoElement = (element: HTMLVideoElement | null) => {
  previewVideoEl = element
}

const stopVideoStream = (stream: MediaStream | null) => {
  if (!stream) {
    return
  }
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

/** 从实时摄像头预览抓取压缩 JPEG 帧，用于与语音同步发送 */
const captureVideoFrame = async (): Promise<File | null> => {
  const video = previewVideoEl
  if (
    !video ||
    !useVoiceCall.getState().cameraEnabled ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    return null
  }
  const scale = Math.min(1, MAX_VIDEO_FRAME_EDGE / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  ctx.drawImage(video, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.78)
  )
  if (!blob) {
    return null
  }
  return new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })
}

type CallSession = {
  epoch: number
  stream: MediaStream | null
  captureCtx: AudioContext | null
  captureSource: MediaStreamAudioSourceNode | null
  captureProcessor: ScriptProcessorNode | null
  playbackCtx: AudioContext | null
  playbackAnalyser: AnalyserNode | null
  playbackSources: Set<AudioBufferSourceNode>
  nextPlayTime: number
  levelFrame: number
  turnController: AbortController | null
  storeUnsubscribe: (() => void) | null
  replySessionId: string | null
  // VAD 缓冲
  preRoll: Float32Array[]
  chunks: Float32Array[]
  totalSamples: number
  speechFrames: number
  consecutiveSpeech: number
  consecutiveSilence: number
  speakingInMic: boolean
}

let activeCall: CallSession | null = null
let callEpoch = 0

const resetVad = (call: CallSession) => {
  call.preRoll = []
  call.chunks = []
  call.totalSamples = 0
  call.speechFrames = 0
  call.consecutiveSpeech = 0
  call.consecutiveSilence = 0
  call.speakingInMic = false
  useVoiceCall.setState({ speechDetected: false })
}

const stopPlayback = (call: CallSession) => {
  for (const source of call.playbackSources) {
    source.onended = null
    try {
      source.stop()
      source.disconnect()
    } catch {
      // 忽略已结束的节点
    }
  }
  call.playbackSources.clear()
  call.nextPlayTime = 0
}

const cleanupTurn = (call: CallSession) => {
  call.turnController?.abort()
  call.turnController = null
  call.storeUnsubscribe?.()
  call.storeUnsubscribe = null
  stopPlayback(call)
}

const teardownCall = (call: CallSession) => {
  callEpoch++
  cancelAnimationFrame(call.levelFrame)
  cleanupTurn(call)
  if (call.captureProcessor) {
    call.captureProcessor.onaudioprocess = null
  }
  for (const node of [call.captureProcessor, call.captureSource, call.playbackAnalyser]) {
    try {
      node?.disconnect()
    } catch {
      // 忽略断开错误
    }
  }
  if (call.stream) {
    for (const track of call.stream.getTracks()) {
      track.stop()
    }
  }
  stopVideoStream(useVoiceCall.getState().videoStream)
  void call.captureCtx?.close().catch(() => {})
  void call.playbackCtx?.close().catch(() => {})
  if (activeCall === call) {
    activeCall = null
  }
}

const resumeListening = (call: CallSession) => {
  if (activeCall !== call || callEpoch !== call.epoch) {
    return
  }
  resetVad(call)
  const { muted } = useVoiceCall.getState()
  useVoiceCall.setState({
    phase: muted ? 'muted' : 'listening',
    level: 0,
    error: null,
  })
}

const findReply = (sessionId: string, replyId: string): AssistantMessage | undefined => {
  const session = useChatStore.getState().sessionCache[sessionId]
  const message = session?.messages.find((item) => item.id === replyId)
  return message?.role === 'assistant' ? message : undefined
}

const runSpeechTurn = async (call: CallSession, wav: Blob) => {
  cleanupTurn(call)
  const controller = new AbortController()
  call.turnController = controller
  useVoiceCall.setState({
    phase: 'transcribing',
    speechDetected: false,
    level: 0,
    error: null,
  })

  try {
    const { apiKey, asrChannel } = useSettings.getState()
    const framePromise = captureVideoFrame()
    // 语音转写与摄像头抓帧上传并行执行，减少额外延迟
    const uploadFramePromise = framePromise.then(async (file) => {
      if (!file) {
        return null
      }
      let serverId: string | null = null
      const { chatProtocol, visionChannel, ocrChannel } = useSettings.getState()
      if (
        chatProtocol === 'deepseek' &&
        visionChannel.mode === 'inherit' &&
        ocrChannel.mode === 'inherit'
      ) {
        try {
          const uploaded = await uploadFile(apiKey ?? '', file, null, controller.signal)
          serverId = uploaded.id
        } catch {
          // 上传失败时保留本地 blob，交由 streamReply 的 prepareFiles 重试或降级
        }
      }
      return {
        id: createId(),
        serverId,
        name: file.name,
        size: file.size,
        isImage: true,
        mimeType: file.type,
        blob: file,
      }
    })

    const transcript = (
      await transcribe(
        apiKey ?? '',
        wav,
        controller.signal,
        asrChannel.mode === 'custom' ? asrChannel : undefined
      )
    ).trim()
    if (controller.signal.aborted || activeCall !== call) {
      return
    }
    if (!transcript) {
      resumeListening(call)
      return
    }
    useVoiceCall.setState({ userText: transcript, assistantText: '', phase: 'thinking' })

    const files = matchesRefusalKeyword(transcript)
      ? []
      : await uploadFramePromise.then((file) => (file ? [file] : []))
    if (controller.signal.aborted || activeCall !== call) {
      return
    }

    const targetSessionId = useVoiceCall.getState().sessionId
    const submitted = sendVoicePrompt(targetSessionId, transcript, files)
    if (!submitted) {
      resumeListening(call)
      return
    }
    call.replySessionId = submitted.sessionId
    useVoiceCall.setState({ sessionId: submitted.sessionId })

    await streamReplyWithTts(call, submitted.sessionId, submitted.replyId, controller)
  } catch (error) {
    if (controller.signal.aborted || activeCall !== call) {
      return
    }
    useVoiceCall.setState({ error: { key: 'voiceInputFailed' } })
    setTimeout(() => {
      if (activeCall === call && !controller.signal.aborted) {
        resumeListening(call)
      }
    }, 1200)
  }
}

const streamReplyWithTts = async (
  call: CallSession,
  sessionId: string,
  replyId: string,
  controller: AbortController
) => {
  const queue: string[] = []
  let spokenOffset = 0
  let streamFinished = false
  let refusalHandled = false
  let wakeRunner: (() => void) | null = null
  const notifyRunner = () => {
    wakeRunner?.()
    wakeRunner = null
  }
  const waitForNext = () =>
    new Promise<void>((resolve) => {
      wakeRunner = resolve
    })

  const enqueueChunk = (raw: string) => {
    const cleaned = cleanSpeechText(raw)
    if (cleaned) {
      queue.push(cleaned)
      notifyRunner()
    }
  }

  const syncReply = () => {
    if (controller.signal.aborted || activeCall !== call) {
      streamFinished = true
      notifyRunner()
      return
    }
    const reply = findReply(sessionId, replyId)
    if (!reply) {
      return
    }
    const { keepRefusedContent, refusalMessage } = useSettings.getState()
    const isSettled =
      reply.status === 'done' || reply.status === 'stopped' || reply.status === 'error'

    if (reply.stopReason === 'refusal' && !keepRefusedContent) {
      if (isSettled && !refusalHandled) {
        refusalHandled = true
        const notice = describeReply(reply, { refusalMessage })
        const refusalText = notice?.text ?? ''
        useVoiceCall.setState({ assistantText: refusalText })
        queue.length = 0
        stopPlayback(call)
        if (refusalText) {
          enqueueChunk(refusalText)
        }
        streamFinished = true
        notifyRunner()
      }
      return
    }

    const fullText = getReplyText(reply)
    if (fullText) {
      useVoiceCall.setState({ assistantText: fullText })
    }

    if (isSettled) {
      const remaining = fullText.slice(spokenOffset)
      spokenOffset = fullText.length
      if (remaining.trim()) {
        enqueueChunk(remaining)
      } else if (!fullText.trim()) {
        const notice = describeReply(reply, { refusalMessage })
        if (notice?.text) {
          useVoiceCall.setState({ assistantText: notice.text })
          if (reply.status !== 'error') {
            enqueueChunk(notice.text)
          } else {
            useVoiceCall.setState({ error: notice.text })
          }
        }
      }
      streamFinished = true
      notifyRunner()
      return
    }

    // 流式输出按句子边界切分提前合成 TTS，缩短首句响应延迟。
    for (;;) {
      const slice = fullText.slice(spokenOffset)
      if (!slice) {
        break
      }
      const match = SENTENCE_END_RE.exec(slice)
      if (!match) {
        break
      }
      const end = match.index + 1
      if (end < 10 && match[0] !== '\n') {
        // 短句继续向后寻找下一个句末标点
        const nextMatch = SENTENCE_END_RE.exec(slice.slice(end))
        if (!nextMatch) {
          break
        }
        const totalEnd = end + nextMatch.index + 1
        spokenOffset += totalEnd
        enqueueChunk(slice.slice(0, totalEnd))
        continue
      }
      spokenOffset += end
      enqueueChunk(slice.slice(0, end))
    }
  }

  call.storeUnsubscribe = useChatStore.subscribe(syncReply)
  syncReply()

  const playbackCtx = call.playbackCtx
  const playbackAnalyser = call.playbackAnalyser
  if (playbackCtx && playbackCtx.state === 'suspended') {
    await playbackCtx.resume().catch(() => {})
  }

  try {
    while (!controller.signal.aborted && activeCall === call) {
      const sentence = queue.shift()
      if (!sentence) {
        if (streamFinished) {
          break
        }
        await waitForNext()
        continue
      }
      if (!playbackCtx || !playbackAnalyser) {
        continue
      }
      const { apiKey, ttsVoice, ttsChannel } = useSettings.getState()
      const { stream, isPcm } = await synthesize(
        apiKey ?? '',
        sentence,
        ttsVoice,
        controller.signal,
        ttsChannel.mode === 'custom' ? ttsChannel : undefined
      )
      const result = await scheduleTtsStream({
        context: playbackCtx,
        destination: playbackAnalyser,
        stream,
        isPcm,
        signal: controller.signal,
        initialNextTime: call.nextPlayTime,
        startDelay: call.playbackSources.size === 0 ? TTS_START_DELAY : 0,
        onSource: (source) => {
          call.playbackSources.add(source)
          source.onended = () => {
            call.playbackSources.delete(source)
          }
        },
        onFirstAudio: () => {
          if (useVoiceCall.getState().phase !== 'speaking') {
            useVoiceCall.setState({ phase: 'speaking' })
          }
        },
      })
      call.nextPlayTime = result.nextTime
    }

    // 等当前排程的最后一段 TTS 播放完毕再自动恢复聆听。
    if (!controller.signal.aborted && activeCall === call && playbackCtx) {
      const remainingMs = Math.max(0, (call.nextPlayTime - playbackCtx.currentTime) * 1000)
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingMs + 120)
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
        })
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && activeCall === call) {
      const msg = describeReadAloudError(error)
      useVoiceCall.setState({ error: msg })
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  } finally {
    call.storeUnsubscribe?.()
    call.storeUnsubscribe = null
    if (call.turnController === controller) {
      call.turnController = null
    }
    call.replySessionId = null
  }

  if (!controller.signal.aborted && activeCall === call) {
    resumeListening(call)
  }
}

const flushCapturedSpeech = (call: CallSession) => {
  if (!call.speakingInMic || call.speechFrames < MIN_SPEECH_FRAMES || call.totalSamples === 0) {
    resetVad(call)
    return
  }
  const chunks = call.chunks
  const totalSamples = call.totalSamples
  resetVad(call)
  const wav = encodeWav(chunks, totalSamples)
  void runSpeechTurn(call, wav)
}

export const startVoiceCall = (sessionId: string | null) => {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    useVoiceCall.setState({
      active: true,
      sessionId,
      phase: 'error',
      error: { key: 'voiceInputRequiresHttps' },
    })
    return
  }
  if (activeCall) {
    teardownCall(activeCall)
  }
  setReadAloudBlocked(true)
  stopReadAloud()

  const epoch = ++callEpoch
  const call: CallSession = {
    epoch,
    stream: null,
    captureCtx: null,
    captureSource: null,
    captureProcessor: null,
    playbackCtx: null,
    playbackAnalyser: null,
    playbackSources: new Set(),
    nextPlayTime: 0,
    levelFrame: 0,
    turnController: null,
    storeUnsubscribe: null,
    replySessionId: null,
    preRoll: [],
    chunks: [],
    totalSamples: 0,
    speechFrames: 0,
    consecutiveSpeech: 0,
    consecutiveSilence: 0,
    speakingInMic: false,
  }
  activeCall = call

  // 在点击手势内同步创建 AudioContext，确保各浏览器允许后续免点击播放 TTS。
  const playbackCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  const playbackAnalyser = playbackCtx.createAnalyser()
  playbackAnalyser.fftSize = 256
  playbackAnalyser.connect(playbackCtx.destination)
  call.playbackCtx = playbackCtx
  call.playbackAnalyser = playbackAnalyser
  if (playbackCtx.state === 'suspended') {
    void playbackCtx.resume().catch(() => {})
  }

  useVoiceCall.setState({
    active: true,
    sessionId,
    phase: 'listening',
    muted: false,
    cameraEnabled: false,
    cameraPending: false,
    videoStream: null,
    speechDetected: false,
    level: 0,
    userText: '',
    assistantText: '',
    error: null,
  })

  const freqData = new Uint8Array(playbackAnalyser.frequencyBinCount)
  const updateSpeakingLevel = () => {
    if (activeCall !== call || callEpoch !== epoch) {
      return
    }
    if (useVoiceCall.getState().phase === 'speaking' && call.playbackAnalyser) {
      call.playbackAnalyser.getByteFrequencyData(freqData)
      let sum = 0
      for (let i = 0; i < freqData.length; i++) {
        sum += freqData[i]
      }
      const normalized = Math.min(1, sum / (freqData.length * 80))
      useVoiceCall.setState({ level: normalized })
    }
    call.levelFrame = requestAnimationFrame(updateSpeakingLevel)
  }
  call.levelFrame = requestAnimationFrame(updateSpeakingLevel)

  void navigator.mediaDevices
    .getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    .then((stream) => {
      if (activeCall !== call || callEpoch !== epoch) {
        for (const track of stream.getTracks()) {
          track.stop()
        }
        return
      }
      call.stream = stream
      const captureCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      const captureSource = captureCtx.createMediaStreamSource(stream)
      const captureProcessor = captureCtx.createScriptProcessor(FRAME_SIZE, 1, 1)
      call.captureCtx = captureCtx
      call.captureSource = captureSource
      call.captureProcessor = captureProcessor

      captureProcessor.onaudioprocess = (event) => {
        if (activeCall !== call || callEpoch !== epoch) {
          return
        }
        const { phase, muted } = useVoiceCall.getState()
        if (phase !== 'listening' || muted) {
          return
        }
        const frame = new Float32Array(event.inputBuffer.getChannelData(0))
        const rms = computeRms(frame)
        const visualLevel = Math.min(1, rms * 10)
        useVoiceCall.setState({ level: visualLevel })

        if (!call.speakingInMic) {
          call.preRoll.push(frame)
          if (call.preRoll.length > PRE_ROLL_FRAMES) {
            call.preRoll.shift()
          }
          if (rms >= SPEECH_RMS_THRESHOLD) {
            call.consecutiveSpeech++
            if (call.consecutiveSpeech >= SPEECH_START_FRAMES) {
              call.speakingInMic = true
              call.speechFrames = call.preRoll.length
              call.chunks = [...call.preRoll]
              call.totalSamples = call.preRoll.length * FRAME_SIZE
              call.preRoll = []
              call.consecutiveSilence = 0
              useVoiceCall.setState({ speechDetected: true })
            }
          } else {
            call.consecutiveSpeech = 0
          }
          return
        }

        call.chunks.push(frame)
        call.totalSamples += frame.length
        if (rms >= SILENCE_RMS_THRESHOLD) {
          call.speechFrames++
          call.consecutiveSilence = 0
        } else {
          call.consecutiveSilence++
        }
        if (
          call.consecutiveSilence >= SILENCE_END_FRAMES ||
          call.chunks.length >= MAX_CAPTURE_FRAMES
        ) {
          flushCapturedSpeech(call)
        }
      }

      captureSource.connect(captureProcessor)
      captureProcessor.connect(captureCtx.destination)
      if (captureCtx.state === 'suspended') {
        void captureCtx.resume().catch(() => {})
      }
    })
    .catch((error: unknown) => {
      if (activeCall !== call || callEpoch !== epoch) {
        return
      }
      useVoiceCall.setState({ phase: 'error', error: describeMicError(error) })
    })
}

export const toggleVoiceCallMute = () => {
  const call = activeCall
  if (!call) {
    return
  }
  const { muted, phase } = useVoiceCall.getState()
  const nextMuted = !muted
  if (nextMuted) {
    resetVad(call)
    useVoiceCall.setState({
      muted: true,
      phase: phase === 'listening' ? 'muted' : phase,
      level: 0,
    })
  } else {
    useVoiceCall.setState({
      muted: false,
      phase: phase === 'muted' ? 'listening' : phase,
    })
  }
}

export const flushVoiceCallSpeech = () => {
  const call = activeCall
  if (!call || useVoiceCall.getState().phase !== 'listening') {
    return
  }
  flushCapturedSpeech(call)
}

export const interruptVoiceCall = () => {
  const call = activeCall
  if (!call) {
    return
  }
  const { phase } = useVoiceCall.getState()
  if (phase === 'thinking' || phase === 'speaking' || phase === 'transcribing') {
    if (call.replySessionId) {
      stopReply(call.replySessionId)
      call.replySessionId = null
    }
    cleanupTurn(call)
    resumeListening(call)
  } else if (phase === 'listening' && call.speakingInMic) {
    flushCapturedSpeech(call)
  }
}

const openCameraStream = async (facingMode: 'user' | 'environment') => {
  const call = activeCall
  if (!call) {
    return
  }
  const epoch = call.epoch
  // 手机端硬件通常同一时间只允许占用一颗摄像头，切换前必须先释放旧流
  stopVideoStream(useVoiceCall.getState().videoStream)
  useVoiceCall.setState({ cameraPending: true, videoStream: null, error: null })
  try {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
      } catch {
        // 桌面端或单摄设备可能不支持 facingMode 约束，回退为默认摄像头
        stream = await navigator.mediaDevices.getUserMedia({ video: true })
      }
    }
    if (activeCall !== call || callEpoch !== epoch) {
      stopVideoStream(stream)
      return
    }
    useVoiceCall.setState({
      cameraEnabled: true,
      cameraPending: false,
      facingMode,
      videoStream: stream,
    })
  } catch (error) {
    if (activeCall !== call || callEpoch !== epoch) {
      return
    }
    useVoiceCall.setState({
      cameraPending: false,
      cameraEnabled: false,
      error: describeCameraError(error),
    })
  }
}

export const toggleVoiceCallCamera = () => {
  const call = activeCall
  if (!call) {
    return
  }
  const { cameraEnabled, cameraPending, facingMode, videoStream } = useVoiceCall.getState()
  if (cameraPending) {
    return
  }
  if (cameraEnabled) {
    stopVideoStream(videoStream)
    useVoiceCall.setState({ cameraEnabled: false, videoStream: null })
  } else {
    void openCameraStream(facingMode)
  }
}

export const switchVoiceCallCamera = () => {
  const { cameraEnabled, cameraPending, facingMode } = useVoiceCall.getState()
  if (!cameraEnabled || cameraPending) {
    return
  }
  const nextFacing = facingMode === 'environment' ? 'user' : 'environment'
  void openCameraStream(nextFacing)
}

export const endVoiceCall = () => {
  setReadAloudBlocked(false)
  const call = activeCall
  if (call) {
    if (call.replySessionId) {
      stopReply(call.replySessionId)
    }
    teardownCall(call)
  }
  useVoiceCall.setState({
    active: false,
    phase: 'idle',
    muted: false,
    cameraEnabled: false,
    cameraPending: false,
    videoStream: null,
    speechDetected: false,
    level: 0,
    userText: '',
    assistantText: '',
    error: null,
  })
}
