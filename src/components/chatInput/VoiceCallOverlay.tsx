import clsx from 'clsx'
import { useEffect, useRef } from 'react'
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
  const active = useVoiceCall((state) => state.active)
  const videoStream = useVoiceCall((state) => state.videoStream)
  const cameraEnabled = useVoiceCall((state) => state.cameraEnabled)
  const phase = useVoiceCall((state) => state.phase)
  const error = useVoiceCall((state) => state.error)
  const speechDetected = useVoiceCall((state) => state.speechDetected)
  const muted = useVoiceCall((state) => state.muted)
  const facingMode = useVoiceCall((state) => state.facingMode)
  const cameraPending = useVoiceCall((state) => state.cameraPending)
  const userText = useVoiceCall((state) => state.userText)
  const assistantText = useVoiceCall((state) => state.assistantText)
  const model = useSettings((state) => state.model)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const centerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const syncLevel = (level: number) => {
      centerRef.current?.style.setProperty('--orb-level', String(level))
    }
    syncLevel(useVoiceCall.getState().level)
    return useVoiceCall.subscribe((state, prev) => {
      if (state.level !== prev.level) {
        syncLevel(state.level)
      }
    })
  }, [active, cameraEnabled, videoStream])

  useEffect(() => {
    const video = videoRef.current
    setVoiceCallVideoElement(video)
    if (video) {
      video.srcObject = videoStream
    }
    return () => {
      if (video) {
        video.srcObject = null
      }
      setVoiceCallVideoElement(null)
    }
  }, [videoStream, cameraEnabled, active])

  useEffect(() => {
    if (!active) {
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
        const target = event.target as HTMLElement | null
        if (target?.closest('button, a, input, textarea, select, [role="button"], [contenteditable]')) {
          return
        }
        event.preventDefault()
        interruptVoiceCall()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      unregisterBack()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active])

  if (!active) {
    return null
  }

  const busy = phase === 'transcribing' || phase === 'thinking' || phase === 'speaking'
  const errorMessage =
    error === null ? null : typeof error === 'string' ? error : t(error.key, error.params)

  const statusLabel = errorMessage
    ? errorMessage
    : phase === 'muted'
      ? t('voiceCallMuted')
      : phase === 'transcribing'
        ? t('voiceCallTranscribing')
        : phase === 'thinking'
          ? t('voiceCallThinking')
          : phase === 'speaking'
            ? t('voiceCallSpeaking')
            : speechDetected
              ? t('voiceCallHearing')
              : t('voiceCallListening')

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('voiceCallTitle')}
    >
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={clsx(styles.liveDot, muted && styles.liveDotMuted)} />
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

      <div ref={centerRef} className={styles.center}>
        {cameraEnabled && videoStream ? (
          <div
            className={styles.videoStage}
            onClick={() => {
              if (busy || speechDetected) {
                interruptVoiceCall()
              }
            }}
          >
            <video
              ref={videoRef}
              className={clsx(styles.videoElement, facingMode === 'user' && styles.videoMirror)}
              autoPlay
              playsInline
              muted
            />
            <button
              type="button"
              className={styles.videoSwitchBtn}
              aria-label={t('voiceCallSwitchCamera')}
              disabled={cameraPending}
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
                speechDetected && phase === 'listening' && styles.orbCoreHearing,
                (phase === 'transcribing' || phase === 'thinking') && styles.orbCoreBusy,
                phase === 'muted' && styles.orbCoreMuted
              )}
            >
              {muted ? <IconMicOff16 /> : <IconVoiceCall16 />}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.orbButton}
            aria-label={busy ? t('voiceCallInterrupt') : statusLabel}
            onClick={() => {
              if (busy || speechDetected) {
                interruptVoiceCall()
              }
            }}
          >
            <span className={styles.orbHalo} />
            <span
              className={clsx(
                styles.orbCore,
                speechDetected && phase === 'listening' && styles.orbCoreHearing,
                (phase === 'transcribing' || phase === 'thinking') && styles.orbCoreBusy,
                phase === 'muted' && styles.orbCoreMuted,
                phase === 'error' && styles.orbCoreError
              )}
            >
              <span className={styles.orbInnerIcon}>
                {muted ? <IconMicOff16 /> : <IconVoiceCall16 />}
              </span>
            </span>
          </button>
        )}

        <div className={clsx(styles.statusText, errorMessage && styles.errorText)}>
          {statusLabel}
        </div>

        {userText || assistantText ? (
          <div className={styles.transcriptBox}>
            {userText ? <div className={styles.userCaption}>{userText}</div> : null}
            {assistantText ? <div className={styles.assistantCaption}>{assistantText}</div> : null}
          </div>
        ) : null}
      </div>

      <div className={styles.controls}>
        <Tooltip content={muted ? t('voiceCallUnmute') : t('voiceCallMute')}>
          <button
            type="button"
            className={clsx(styles.controlBtn, muted && styles.controlBtnActive)}
            aria-label={muted ? t('voiceCallUnmute') : t('voiceCallMute')}
            aria-pressed={muted}
            onClick={toggleVoiceCallMute}
          >
            {muted ? <IconMicOff16 /> : <IconMicOutline16 />}
          </button>
        </Tooltip>

        <Tooltip content={cameraEnabled ? t('voiceCallCameraOff') : t('voiceCallCameraOn')}>
          <button
            type="button"
            className={clsx(styles.controlBtn, cameraEnabled && styles.controlBtnActive)}
            aria-label={cameraEnabled ? t('voiceCallCameraOff') : t('voiceCallCameraOn')}
            aria-pressed={cameraEnabled}
            disabled={cameraPending}
            onClick={toggleVoiceCallCamera}
          >
            {cameraEnabled ? <IconCameraOutline16 /> : <IconCameraOff16 />}
          </button>
        </Tooltip>

        {cameraEnabled ? (
          <Tooltip content={t('voiceCallSwitchCamera')}>
            <button
              type="button"
              className={styles.controlBtn}
              aria-label={t('voiceCallSwitchCamera')}
              disabled={cameraPending}
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
        ) : phase === 'listening' && speechDetected ? (
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
