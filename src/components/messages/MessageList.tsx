import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { clearSearchScrollTarget, useSessionSearch } from '../sider/sessionSearchState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ConversationTimeline, extractTimelineTurns } from './ConversationTimeline.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'
import styles from './MessageList.module.css'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/** 超长对话初始只挂载最近 N 条消息，避免全量 Markdown AST 解析与 DOM 挂载卡死主线程 */
const INITIAL_VISIBLE_COUNT = 40
const LOAD_MORE_STEP = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const prependScrollRef = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  const searchJumpActiveRef = useRef(false)
  const targetScroll = useSessionSearch((state) => state.targetScroll)
  const [localJump, setLocalJump] = useState<{ messageId: string; nonce: number } | null>(null)
  const jumpNonceRef = useRef(0)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [activeTurnIndex, setActiveTurnIndex] = useState(0)
  const [windowState, setWindowState] = useState<{ sessionId: string; count: number }>(() => ({
    sessionId: session.id,
    count: INITIAL_VISIBLE_COUNT,
  }))
  const visibleCount = windowState.sessionId === session.id ? windowState.count : INITIAL_VISIBLE_COUNT

  const messages = useMemo(() => getVisibleMessages(session), [session])
  const attachmentOnlyLabel = t('timelineAttachmentOnly')
  const noAnswerLabel = t('timelineNoAnswer')
  const timelineTurns = useMemo(
    () => extractTimelineTurns(messages, attachmentOnlyLabel, noAnswerLabel),
    [messages, attachmentOnlyLabel, noAnswerLabel]
  )
  const turnCountRef = useRef(0)
  turnCountRef.current = timelineTurns.length
  const activeJump = useMemo(
    () =>
      targetScroll?.sessionId === session.id
        ? { messageId: targetScroll.messageId, nonce: targetScroll.nonce, fromSearch: true }
        : localJump
          ? { messageId: localJump.messageId, nonce: localJump.nonce, fromSearch: false }
          : null,
    [session.id, targetScroll, localJump]
  )

  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }

  // 搜索跳转或时间线跳转指向更早的消息时自动扩充渲染窗口，保证目标节点在 DOM 中可见。
  const targetIndex = activeJump
    ? messages.findIndex((m) => m.id === activeJump.messageId)
    : -1
  const requiredForTarget = targetIndex >= 0 ? messages.length - targetIndex + 6 : 0
  const effectiveVisibleCount = Math.max(visibleCount, requiredForTarget)
  const startIndex = Math.max(0, messages.length - effectiveVisibleCount)
  const renderedMessages = useMemo(
    () => (startIndex > 0 ? messages.slice(startIndex) : messages),
    [messages, startIndex]
  )

  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  useLayoutEffect(() => {
    const pending = prependScrollRef.current
    const scroll = scrollRef.current
    if (!pending || !scroll) {
      return
    }
    prependScrollRef.current = null
    const delta = scroll.scrollHeight - pending.prevHeight
    scroll.scrollTop = pending.prevTop + Math.max(0, delta)
    scrollTopRef.current = scroll.scrollTop
  }, [renderedMessages.length])

  // 切换会话时重置搜索跳转标记，避免旧会话状态影响新会话吸底。
  useLayoutEffect(() => {
    searchJumpActiveRef.current = false
    setLocalJump(null)
    setActiveTurnIndex(Math.max(0, turnCountRef.current - 1))
  }, [session.id])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    if (activeJump || searchJumpActiveRef.current) {
      stickyRef.current = false
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom, activeJump])

  useEffect(() => {
    if (!activeJump) {
      return
    }
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }
    if (windowState.sessionId !== session.id || windowState.count < effectiveVisibleCount) {
      setWindowState({ sessionId: session.id, count: effectiveVisibleCount })
    }
    const targetEl = scroll.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(activeJump.messageId)}"]`
    )
    if (!targetEl) {
      return
    }
    searchJumpActiveRef.current = true
    stickyRef.current = false
    const scrollRect = scroll.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    const nextTop =
      scroll.scrollTop +
      (targetRect.top - scrollRect.top) -
      Math.max(24, (scroll.clientHeight - targetRect.height) * 0.32)
    scroll.scrollTop = Math.max(0, nextTop)
    scrollTopRef.current = scroll.scrollTop
    setHighlightedId(activeJump.messageId)
    const matchedTurn = timelineTurns.find((turn) => turn.userMessageId === activeJump.messageId)
    if (matchedTurn) {
      setActiveTurnIndex(matchedTurn.index)
    }
    if (activeJump.fromSearch) {
      clearSearchScrollTarget(activeJump.nonce)
    } else {
      setLocalJump(null)
    }
  }, [session.id, renderedMessages, activeJump, windowState, effectiveVisibleCount, timelineTurns])

  useEffect(() => {
    if (!highlightedId) {
      return
    }
    const timer = window.setTimeout(() => {
      setHighlightedId(null)
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [highlightedId])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      searchJumpActiveRef.current = false
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  const loadEarlier = () => {
    const scroll = scrollRef.current
    if (scroll) {
      prependScrollRef.current = { prevHeight: scroll.scrollHeight, prevTop: scroll.scrollTop }
    }
    stickyRef.current = false
    setWindowState({
      sessionId: session.id,
      count: effectiveVisibleCount + LOAD_MORE_STEP,
    })
  }

  const jumpToMessage = useCallback((messageId: string) => {
    jumpNonceRef.current += 1
    setLocalJump({ messageId, nonce: jumpNonceRef.current })
  }, [])

  useEffect(() => {
    if (timelineTurns.length < 2) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return
      }
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) {
        return
      }
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? -1 : 1
      const nextIndex = Math.max(0, Math.min(timelineTurns.length - 1, activeTurnIndex + delta))
      const nextTurn = timelineTurns[nextIndex]
      if (nextTurn) {
        setActiveTurnIndex(nextIndex)
        jumpToMessage(nextTurn.userMessageId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [timelineTurns, activeTurnIndex, jumpToMessage])

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    let activeFrame = 0
    const syncActiveTurn = () => {
      activeFrame = 0
      if (timelineTurns.length < 2) {
        return
      }
      if (stickyRef.current) {
        setActiveTurnIndex(timelineTurns.length - 1)
        return
      }
      const probeY = el.getBoundingClientRect().top + el.clientHeight * 0.28
      let matched = timelineTurns[0].index
      for (const turn of timelineTurns) {
        const node = el.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(turn.userMessageId)}"]`
        )
        if (!node) {
          continue
        }
        if (node.getBoundingClientRect().top <= probeY) {
          matched = turn.index
        } else {
          break
        }
      }
      setActiveTurnIndex(matched)
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
        searchJumpActiveRef.current = false
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      if (!activeFrame && timelineTurns.length >= 2) {
        activeFrame = requestAnimationFrame(syncActiveTurn)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(activeFrame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [isMobile, scrollToBottom, timelineTurns])

  const lastIndex = renderedMessages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div className={styles.host}>
        <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              {startIndex > 0 ? (
                <div className={styles.loadEarlierRow}>
                  <button type="button" className={styles.loadEarlierBtn} onClick={loadEarlier}>
                    {t('loadEarlierMessages', { count: startIndex })}
                  </button>
                </div>
              ) : null}
              {renderedMessages.map((message, index) => (
                <div
                  key={message.id}
                  data-message-id={message.id}
                  className={clsx(highlightedId === message.id && styles.searchHighlight)}
                >
                  {message.role === 'user' ? (
                    <UserMessage
                      sessionId={session.id}
                      message={message}
                      retryUploadId={uploadRetryId}
                      isFirst={startIndex + index === 0}
                      isLast={index === lastIndex || index === lastIndex - 1}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                    />
                  ) : (
                    <AssistantMessage
                      sessionId={session.id}
                      message={message}
                      isLast={index === lastIndex}
                      streaming={streaming && index === lastIndex}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
          {footer}
        </div>
        <ConversationTimeline
          sessionId={session.id}
          title={session.title}
          turns={timelineTurns}
          activeTurnIndex={activeTurnIndex}
          isMobile={isMobile}
          onJumpToTurn={jumpToMessage}
        />
      </div>
    </ScrollToBottomContext.Provider>
  )
}
