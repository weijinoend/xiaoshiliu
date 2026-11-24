import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import { loadFile } from '../../services/chat/db.js'
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
  const [ownedUrl, setOwnedUrl] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const lastTouchEndAtRef = useRef(0)

  const stateRef = useRef({ scale: 1, x: 0, y: 0 })
  stateRef.current = { scale, x: offset.x, y: offset.y }

  const pointerPanRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const suppressStageClickRef = useRef(false)

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

  const updateZoom = useCallback((next: number) => {
    const clamped = clampScale(next)
    setScale(clamped)
    if (clamped <= 1.02) {
      setOffset({ x: 0, y: 0 })
    }
  }, [])

  useEffect(() => {
    const fileId = current?.fileId
    if (!fileId) {
      setOwnedUrl(null)
      return
    }
    let active = true
    let objectUrl: string | null = null
    void loadFile(fileId)
      .then((blob) => {
        if (!active || !blob) {
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setOwnedUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      active = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
      setOwnedUrl(null)
    }
  }, [current?.fileId])

  useEffect(() => {
    resetTransform()
  }, [current?.src, current?.fileId, resetTransform])

  useEffect(() => {
    const stage = stageRef.current
    if (!current || !stage) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = event.deltaY < 0 ? 0.25 : -0.25
      updateZoom(stateRef.current.scale + delta)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [current, updateZoom])

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

  const displaySrc = ownedUrl ?? current.src

  const toggleDoubleZoom = () => {
    if (stateRef.current.scale > 1.15) {
      resetTransform()
    } else {
      setScale(DOUBLE_TAP_SCALE)
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0 || stateRef.current.scale <= 1.02) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: stateRef.current.x,
      originY: stateRef.current.y,
      moved: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = pointerPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      pan.moved = true
    }
    setOffset({ x: pan.originX + dx, y: pan.originY + dy })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = pointerPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) {
      return
    }
    if (pan.moved) {
      suppressStageClickRef.current = true
    }
    pointerPanRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // ignore
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
      lastTouchEndAtRef.current = Date.now()
      if (gesture.mode === 'pan' && !gesture.moved) {
        const now = lastTouchEndAtRef.current
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

  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressStageClickRef.current) {
      suppressStageClickRef.current = false
      return
    }
    if (event.target === event.currentTarget && stateRef.current.scale <= 1.05) {
      closeImageViewer()
    }
  }

  const downloadImage = () => {
    void saveDownloadedUrl(displaySrc, current.filename || 'image.png')
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
        ref={stageRef}
        className={styles.stage}
        onClick={onStageClick}
        onDoubleClick={() => {
          if (Date.now() - lastTouchEndAtRef.current > 400) {
            toggleDoubleZoom()
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <img
          src={displaySrc}
          alt={current.alt ?? ''}
          draggable={false}
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
