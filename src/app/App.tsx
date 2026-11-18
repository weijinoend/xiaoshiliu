import clsx from 'clsx'
import { useEffect, useRef, type TouchEvent } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import { installAndroidBackBridge, registerAndroidBackHandler } from './androidBack.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { TokenLimitModal } from '../components/settings/TokenLimitModal.js'
import { UpdateModal } from '../components/settings/UpdateModal.js'
import { syncDailyTokenDate } from '../services/tokenUsage.js'
import { checkForUpdates } from '../services/updater.js'
import { VoiceCallOverlay } from '../components/chatInput/VoiceCallOverlay.js'
import { ImageViewer } from '../components/messages/ImageViewer.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { onMemoryUpdated } from '../services/chat/savedMemory.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import {
  closeMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { SessionSearchOverlay } from '../components/sider/SessionSearchOverlay.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const mobileSiderOpen = useMobileSider((state) => state.open) && isMobile
  const mainRef = useRef<HTMLElement>(null)
  const gestureRef = useRef<{
    startX: number
    startY: number
    startTime: number
    initialOpen: boolean
    drawerWidth: number
    offset: number
    axis: 'pending' | 'x' | 'y'
  } | null>(null)

  const hasHorizontalScroll = (target: EventTarget | null) => {
    let node = target as HTMLElement | null
    while (node && node !== mainRef.current) {
      if (node.scrollWidth > node.clientWidth + 2) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') {
          return true
        }
      }
      node = node.parentElement
    }
    return false
  }

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (!isMobile || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    const initialOpen = useMobileSider.getState().open
    if (!initialOpen && hasHorizontalScroll(event.target)) {
      return
    }
    const drawerWidth = Math.min(300, window.innerWidth - 56)
    gestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      initialOpen,
      drawerWidth,
      offset: initialOpen ? drawerWidth : 0,
      axis: 'pending',
    }
  }

  const onTouchMove = (event: TouchEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    const main = mainRef.current
    if (!gesture || !main || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    const dx = touch.clientX - gesture.startX
    const dy = touch.clientY - gesture.startY
    if (gesture.axis === 'pending') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
        return
      }
      if (Math.abs(dy) >= Math.abs(dx) || (!gesture.initialOpen && dx <= 0)) {
        gesture.axis = 'y'
        return
      }
      gesture.axis = 'x'
    }
    if (gesture.axis !== 'x') {
      return
    }
    const offset = gesture.initialOpen
      ? Math.max(0, Math.min(gesture.drawerWidth, gesture.drawerWidth + dx))
      : Math.max(0, Math.min(gesture.drawerWidth, dx))
    gesture.offset = offset
    const radius = Math.min(20, (offset / gesture.drawerWidth) * 20)
    main.style.transition = 'none'
    main.style.transform = `translate3d(${offset}px, 0, 0)`
    main.style.borderRadius = `${radius}px`
  }

  const finishTouch = () => {
    const gesture = gestureRef.current
    const main = mainRef.current
    gestureRef.current = null
    if (!gesture || !main || gesture.axis !== 'x') {
      return
    }
    main.style.transition = ''
    main.style.transform = ''
    main.style.borderRadius = ''
    const elapsed = Math.max(1, Date.now() - gesture.startTime)
    const startOffset = gesture.initialOpen ? gesture.drawerWidth : 0
    const velocity = (gesture.offset - startOffset) / elapsed
    let nextOpen: boolean
    if (velocity > 0.35) {
      nextOpen = true
    } else if (velocity < -0.35) {
      nextOpen = false
    } else {
      nextOpen = gesture.initialOpen
        ? gesture.offset > gesture.drawerWidth * 0.7
        : gesture.offset > gesture.drawerWidth * 0.28
    }
    if (nextOpen) {
      openMobileSider()
    } else {
      closeMobileSider()
    }
  }

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(
    () =>
      onMemoryUpdated((summary) => {
        if (useSettings.getState().memoryUpdateNotice) {
          showToast({ key: 'memorySavedToast', params: { summary } })
        }
      }),
    []
  )
  useEffect(bindChatPersistence, [])
  useEffect(installAndroidBackBridge, [])
  useEffect(() => {
    if (!mobileSiderOpen) {
      return
    }
    return registerAndroidBackHandler(50, () => {
      closeMobileSider()
      return true
    })
  }, [mobileSiderOpen])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    syncDailyTokenDate()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
    if (!useSettings.getState().autoCheckUpdate) {
      return
    }
    const timer = window.setTimeout(() => void checkForUpdates({ manual: false }), 2500)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main
          ref={mainRef}
          className={clsx(
            styles.main,
            isMobile && styles.mobileMain,
            mobileSiderOpen && styles.mobileMainOpen
          )}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={finishTouch}
          onTouchCancel={finishTouch}
        >
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
          {mobileSiderOpen ? (
            <div className={styles.mobileBackdrop} onClick={closeMobileSider} aria-hidden />
          ) : null}
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <TokenLimitModal />
      <UpdateModal />
      <VoiceCallOverlay />
      <ImageViewer />
      <SessionSearchOverlay />
      <Toast />
    </>
  )
}
