import clsx from 'clsx'
import { useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  endVoiceCall,
  flushVoiceCallSpeech,
  interruptVoiceCall,
  setVoiceCallVideoElement,
  switchVoiceCallCamera,
  toggleVoiceCallCamera,
  toggleVoiceCallMute,
  useVoiceCall,
} from '../../services/speech/voiceCall.js'
import {
  IconCameraOff16,
  IconCameraOutline16,
  IconCloseOutline16,
  IconFlipCamera16,
  IconMicOff16,
  IconMicOutline16,
  IconPhoneOff16,
  IconSendOutline16,
  IconStopFill16,
  IconVoiceCall16,
} from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './VoiceCallOverlay.module.css'

/** Gemini Live 风格的连续语音通话浮层 */
export const VoiceCallOverlay = () => {
  const t = useTranslate()
  const call = useVoiceCall()
  const model = useSettings((state) => state.model)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = videoRef.current
    setVoiceCallVideoElement(video)
    if (video) {
      video.srcObject = call.videoStream
    }
    return () => {
      if (video) {
        video.srcObject = null
      }
      setVoiceCallVideoElement(null)
    }
  }, [call.videoStream, call.cameraEnabled])

  useEffect(() => {
    if (!call.active) {
      return
    }
    const unregisterBack = registerAndroidBackHandler(150, () => {
      endVoiceCall()
      return true
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        endVoiceCall()
      } else if (event.code === 'Space' && !event.repeat) {
        event.preventDefault()
        interruptVoiceCall()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      unregisterBack()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [call.active])

  if (!call.active) {
    return null
  }

  const busy =
    call.phase === 'transcribing' || call.phase === 'thinking' || call.phase === 'speaking'
  const errorMessage =
    call.error === null
      ? null
      : typeof call.error === 'string'
        ? call.error
        : t(call.error.key, call.error.params)

  const statusLabel = errorMessage
    ? errorMessage
    : call.phase === 'muted'
      ? t('voiceCallMuted')
      : call.phase === 'transcribing'
        ? t('voiceCallTranscribing')
        : call.phase === 'thinking'
          ? t('voiceCallThinking')
          : call.phase === 'speaking'
            ? t('voiceCallSpeaking')
            : call.speechDetected
              ? t('voiceCallHearing')
              : t('voiceCallListening')

  const orbStyle = { '--orb-level': String(call.level) } as CSSProperties

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('voiceCallTitle')}
    >
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={clsx(styles.liveDot, call.muted && styles.liveDotMuted)} />
          <span className={styles.title}>{t('voiceCallTitle')}</span>
          <span className={styles.modelTag}>{model}</span>
        </div>
        <button
          type="button"
          className={styles.controlBtn}
          style={{ width: 38, height: 38 }}
          aria-label={t('voiceCallHangUp')}
          onClick={endVoiceCall}
        >
          <IconCloseOutline16 />
        </button>
      </div>

      <div className={styles.center}>
        {call.cameraEnabled && call.videoStream ? (
          <div
            className={styles.videoStage}
            style={orbStyle}
            onClick={() => {
              if (busy || call.speechDetected) {
                interruptVoiceCall()
              }
            }}
          >
            <video
              ref={videoRef}
              className={clsx(
                styles.videoElement,
                call.facingMode === 'user' && styles.videoMirror
              )}
              autoPlay
              playsInline
              muted
            />
            <button
              type="button"
              className={styles.videoSwitchBtn}
              aria-label={t('voiceCallSwitchCamera')}
              onClick={(event) => {
                event.stopPropagation()
                switchVoiceCallCamera()
              }}
            >
              <IconFlipCamera16 />
            </button>
            <div
              className={clsx(
                styles.videoOrbBadge,
                call.speechDetected && call.phase === 'listening' && styles.orbCoreHearing,
                (call.phase === 'transcribing' || call.phase === 'thinking') && styles.orbCoreBusy,
                call.phase === 'muted' && styles.orbCoreMuted
              )}
            >
              {call.muted ? <IconMicOff16 /> : <IconVoiceCall16 />}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.orbButton}
            style={orbStyle}
            aria-label={busy ? t('voiceCallInterrupt') : statusLabel}
            onClick={() => {
              if (busy || call.speechDetected) {
                interruptVoiceCall()
              }
            }}
          >
            <span className={styles.orbHalo} />
            <span
              className={clsx(
                styles.orbCore,
                call.speechDetected && call.phase === 'listening' && styles.orbCoreHearing,
                (call.phase === 'transcribing' || call.phase === 'thinking') && styles.orbCoreBusy,
                call.phase === 'muted' && styles.orbCoreMuted,
                call.phase === 'error' && styles.orbCoreError
              )}
            >
              <span className={styles.orbInnerIcon}>
                {call.muted ? <IconMicOff16 /> : <IconVoiceCall16 />}
              </span>
            </span>
          </button>
        )}

        <div className={clsx(styles.statusText, errorMessage && styles.errorText)}>
          {statusLabel}
        </div>

        {call.userText || call.assistantText ? (
          <div className={styles.transcriptBox}>
            {call.userText ? <div className={styles.userCaption}>{call.userText}</div> : null}
            {call.assistantText ? (
              <div className={styles.assistantCaption}>{call.assistantText}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={styles.controls}>
        <Tooltip content={call.muted ? t('voiceCallUnmute') : t('voiceCallMute')}>
          <button
            type="button"
            className={clsx(styles.controlBtn, call.muted && styles.controlBtnActive)}
            aria-label={call.muted ? t('voiceCallUnmute') : t('voiceCallMute')}
            aria-pressed={call.muted}
            onClick={toggleVoiceCallMute}
          >
            {call.muted ? <IconMicOff16 /> : <IconMicOutline16 />}
          </button>
        </Tooltip>

        <Tooltip content={call.cameraEnabled ? t('voiceCallCameraOff') : t('voiceCallCameraOn')}>
          <button
            type="button"
            className={clsx(styles.controlBtn, call.cameraEnabled && styles.controlBtnActive)}
            aria-label={call.cameraEnabled ? t('voiceCallCameraOff') : t('voiceCallCameraOn')}
            aria-pressed={call.cameraEnabled}
            disabled={call.cameraPending}
            onClick={toggleVoiceCallCamera}
          >
            {call.cameraEnabled ? <IconCameraOutline16 /> : <IconCameraOff16 />}
          </button>
        </Tooltip>

        {call.cameraEnabled ? (
          <Tooltip content={t('voiceCallSwitchCamera')}>
            <button
              type="button"
              className={styles.controlBtn}
              aria-label={t('voiceCallSwitchCamera')}
              disabled={call.cameraPending}
              onClick={switchVoiceCallCamera}
            >
              <IconFlipCamera16 />
            </button>
          </Tooltip>
        ) : null}

        {busy ? (
          <Tooltip content={t('voiceCallInterrupt')}>
            <button
              type="button"
              className={styles.controlBtn}
              aria-label={t('voiceCallInterrupt')}
              onClick={interruptVoiceCall}
            >
              <IconStopFill16 />
            </button>
          </Tooltip>
        ) : call.phase === 'listening' && call.speechDetected ? (
          <Tooltip content={t('voiceCallSendNow')}>
            <button
              type="button"
              className={styles.controlBtn}
              aria-label={t('voiceCallSendNow')}
              onClick={flushVoiceCallSpeech}
            >
              <IconSendOutline16 />
            </button>
          </Tooltip>
        ) : null}

        <Tooltip content={t('voiceCallHangUp')}>
          <button
            type="button"
            className={clsx(styles.controlBtn, styles.hangupBtn)}
            aria-label={t('voiceCallHangUp')}
            onClick={endVoiceCall}
          >
            <IconPhoneOff16 />
          </button>
        </Tooltip>
      </div>
    </div>,
    document.body
  )
}
