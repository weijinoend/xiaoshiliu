import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type TouchEvent,
  type WheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { saveDownloadedUrl } from '../../utils/download.js'
import { closeImageViewer, useImageViewer } from './imageViewerState.js'
import styles from './ImageViewer.module.css'

const MIN_SCALE = 1
const MAX_SCALE = 5
const DOUBLE_TAP_SCALE = 2.4

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

const touchDistance = (
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number }
) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

/** 全屏图片预览器：支持双指缩放、双击放大/还原、拖拽平移、滚轮缩放、顶部关闭与安卓返回键关闭 */
export const ImageViewer = () => {
  const t = useTranslate()
  const current = useImageViewer((state) => state.current)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  const stateRef = useRef({ scale: 1, x: 0, y: 0 })
  stateRef.current = { scale, x: offset.x, y: offset.y }

  const gestureRef = useRef<{
    mode: 'none' | 'pan' | 'pinch'
    startX: number
    startY: number
    originX: number
    originY: number
    pinchStartDist: number
    pinchStartScale: number
    lastTapAt: number
    moved: boolean
  }>({
    mode: 'none',
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    pinchStartDist: 0,
    pinchStartScale: 1,
    lastTapAt: 0,
    moved: false,
  })

  const resetTransform = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    resetTransform()
  }, [current?.src, resetTransform])

  useEffect(() => {
    if (!current) {
      return
    }
    const unregisterBack = registerAndroidBackHandler(200, () => closeImageViewer())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeImageViewer()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      unregisterBack()
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [current])

  if (!current) {
    return null
  }

  const updateZoom = (next: number) => {
    const clamped = clampScale(next)
    setScale(clamped)
    if (clamped <= 1.02) {
      setOffset({ x: 0, y: 0 })
    }
  }

  const toggleDoubleZoom = () => {
    if (stateRef.current.scale > 1.15) {
      resetTransform()
    } else {
      setScale(DOUBLE_TAP_SCALE)
    }
  }

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (event.touches.length === 2) {
      gesture.mode = 'pinch'
      gesture.pinchStartDist = Math.max(1, touchDistance(event.touches[0], event.touches[1]))
      gesture.pinchStartScale = stateRef.current.scale
      gesture.moved = true
      return
    }
    if (event.touches.length === 1) {
      const touch = event.touches[0]
      gesture.mode = 'pan'
      gesture.startX = touch.clientX
      gesture.startY = touch.clientY
      gesture.originX = stateRef.current.x
      gesture.originY = stateRef.current.y
      gesture.moved = false
    }
  }

  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.mode === 'pinch' && event.touches.length === 2) {
      const dist = touchDistance(event.touches[0], event.touches[1])
      const next = clampScale((dist / gesture.pinchStartDist) * gesture.pinchStartScale)
      setScale(next)
      if (next <= 1.02) {
        setOffset({ x: 0, y: 0 })
      }
      return
    }
    if (gesture.mode === 'pan' && event.touches.length === 1 && stateRef.current.scale > 1.02) {
      const touch = event.touches[0]
      const dx = touch.clientX - gesture.startX
      const dy = touch.clientY - gesture.startY
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        gesture.moved = true
      }
      setOffset({ x: gesture.originX + dx, y: gesture.originY + dy })
    }
  }

  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (event.touches.length === 1 && gesture.mode === 'pinch') {
      const touch = event.touches[0]
      gesture.mode = 'pan'
      gesture.startX = touch.clientX
      gesture.startY = touch.clientY
      gesture.originX = stateRef.current.x
      gesture.originY = stateRef.current.y
      return
    }
    if (event.touches.length === 0) {
      if (gesture.mode === 'pan' && !gesture.moved) {
        const now = Date.now()
        if (now - gesture.lastTapAt < 280) {
          gesture.lastTapAt = 0
          toggleDoubleZoom()
        } else {
          gesture.lastTapAt = now
        }
      }
      gesture.mode = 'none'
    }
  }

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const delta = event.deltaY < 0 ? 0.25 : -0.25
    updateZoom(stateRef.current.scale + delta)
  }

  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && stateRef.current.scale <= 1.05) {
      closeImageViewer()
    }
  }

  const downloadImage = () => {
    void saveDownloadedUrl(current.src, current.filename || 'image.png')
      .then((dest) => {
        if (dest === 'browser') {
          showToast({ key: 'imageSavedToast' })
        }
      })
      .catch(() => {
        showToast({ key: 'imageSaveFailedToast' })
      })
  }

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={current.alt ?? t('imageViewerClose')}
    >
      <div className={styles.topbar}>
        <div className={styles.title}>{current.filename ?? current.alt ?? ''}</div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('imageViewerDownload')}
            title={t('imageViewerDownload')}
            onClick={downloadImage}
          >
            <IconDownloadOutline16 />
          </button>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.closeBtn}`}
            aria-label={t('imageViewerClose')}
            title={t('imageViewerClose')}
            onClick={closeImageViewer}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      </div>

      <div
        className={styles.stage}
        onClick={onStageClick}
        onDoubleClick={toggleDoubleZoom}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <img
          src={current.src}
          alt={current.alt ?? ''}
          className={styles.image}
          style={{
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          }}
        />
      </div>

      <div className={styles.bottomBar}>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label={t('imageViewerZoomOut')}
          onClick={() => updateZoom(scale - 0.5)}
        >
          -
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label={t('imageViewerResetZoom')}
          onClick={resetTransform}
        >
          <span className={styles.scaleLabel}>{Math.round(scale * 100)}%</span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          aria-label={t('imageViewerZoomIn')}
          onClick={() => updateZoom(scale + 0.5)}
        >
          +
        </button>
      </div>
    </div>,
    document.body
  )
}
