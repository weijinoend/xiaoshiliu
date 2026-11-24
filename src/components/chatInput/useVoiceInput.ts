import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import { transcribe } from '../../services/api/speech.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/**
 * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
 * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
 */
const AVAILABLE = typeof window === 'undefined' || window.isSecureContext

const describeRecordingError = (error: unknown): TranslationMessage => {
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

/**
 * 语音输入（oneshot）：点击开始录音，再次点击结束并转写，结果交给 onText 填入输入框。
 * 转写中再次点击取消。录满 120 秒自动结束。
 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  const startingRef = useRef(false)
  const startPromiseRef = useRef<Promise<Recording | null> | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(() => {
    operationRef.current++
    startingRef.current = false
    startPromiseRef.current = null
    recordingRef.current?.cancel()
    recordingRef.current = null
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const cancel = useCallback(() => {
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  const finish = useCallback(async () => {
    const operation = operationRef.current
    if (!recordingRef.current && startingRef.current && startPromiseRef.current) {
      await startPromiseRef.current
      if (operationRef.current !== operation) {
        return
      }
    }
    const recording = recordingRef.current
    if (!recording) {
      // 录音尚未就绪且等待后仍无实例（例如权限拒绝或取消），安全恢复 idle。
      cancel()
      return
    }
    recordingRef.current = null
    let controller: AbortController | null = null
    try {
      let audio: Blob | null
      try {
        audio = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation || !audio) {
        return
      }
      controller = new AbortController()
      controllerRef.current = controller
      setStatus('transcribing')
      const { apiKey, asrChannel } = useSettings.getState()
      const text = await transcribe(
        apiKey ?? '',
        audio,
        controller.signal,
        asrChannel.mode === 'custom' ? asrChannel : undefined
      )
      if (controller.signal.aborted || operationRef.current !== operation) {
        return
      }
      if (text.trim()) {
        onTextRef.current(text.trim())
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    } catch {
      if (operationRef.current === operation && !controller?.signal.aborted) {
        showToast({ key: 'voiceInputFailed' })
      }
    } finally {
      if (operationRef.current === operation) {
        controllerRef.current = null
        setStatus('idle')
      }
    }
  }, [cancel])

  const start = useCallback(async () => {
    if (!AVAILABLE || status !== 'idle' || startingRef.current) {
      return
    }
    const operation = ++operationRef.current
    startingRef.current = true
    // 立即进入 recording 状态，确保移动端 340ms 长按触发后同步挂上 touch-action/user-select 抑制，防止 Android WebView 在 getUserMedia 等待期间触发 pointercancel。
    setStatus('recording')
    const startPromise = (async (): Promise<Recording | null> => {
      try {
        const recording = await startRecording(() => {
          if (operationRef.current === operation) {
            showToast({ key: 'voiceInputLimitReached' })
            void finish()
          }
        })
        if (operationRef.current !== operation) {
          recording.cancel()
          return null
        }
        recordingRef.current = recording
        return recording
      } catch (error) {
        if (operationRef.current === operation) {
          setStatus('idle')
          showToast(describeRecordingError(error))
        }
        return null
      } finally {
        if (operationRef.current === operation) {
          startingRef.current = false
          startPromiseRef.current = null
        }
      }
    })()
    startPromiseRef.current = startPromise
    await startPromise
  }, [status, finish])

  const toggle = useCallback(async () => {
    if (!AVAILABLE) {
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    await start()
  }, [status, finish, cancel, start])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])

  /** 当前录音的频谱分析节点，未录音时为 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])

  return { status, seconds, getAnalyser, start, finish, toggle, cancel, available: AVAILABLE }
}
