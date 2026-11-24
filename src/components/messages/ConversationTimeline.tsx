import clsx from 'clsx'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import { getReplyText } from '../../services/chat/reply.js'
import type { Message } from '../../services/chat/types.js'
import styles from './ConversationTimeline.module.css'

/** 不超过该轮次时轨道逐轮显示圆点并弹出单轮预览气泡；超出后自动聚合成胶囊分段 + 目录总览卡片 */
const COMPACT_TURN_THRESHOLD = 18
const MAX_GROUP_BUCKETS = 12

export type TimelineTurn = {
  index: number
  userMessageId: string
  createdAt: number
  userSummary: string
  replySummary: string
}

type RailNode =
  | { kind: 'dot'; startTurn: number; endTurn: number; focusTurn: number }
  | { kind: 'pill'; startTurn: number; endTurn: number; focusTurn: number }

const collapseText = (raw: string, max = 140) => {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) {
    return flat
  }
  return `${flat.slice(0, max - 1)}…`
}

const formatClock = (timestamp: number) => {
  const d = new Date(timestamp)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const formatFullDateTime = (timestamp: number, locale: string) => {
  const d = new Date(timestamp)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (locale === 'zh-CN') {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

const formatRangeHeader = (startTs: number, endTs: number, locale: string) => {
  const start = new Date(startTs)
  const end = new Date(endTs)
  if (locale === 'zh-CN') {
    const day = `${start.getMonth() + 1}月${start.getDate()}日`
    return `${day} ${formatClock(startTs)} – ${formatClock(endTs)}`
  }
  const sameDay = start.toDateString() === end.toDateString()
  const startDay = `${start.getMonth() + 1}/${start.getDate()} ${formatClock(startTs)}`
  return `${startDay} – ${sameDay ? formatClock(endTs) : `${end.getMonth() + 1}/${end.getDate()} ${formatClock(endTs)}`}`
}

export const extractTimelineTurns = (
  messages: Message[],
  attachmentLabel: string,
  noAnswerLabel: string
): TimelineTurn[] => {
  const turns: TimelineTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'user') {
      continue
    }
    const next = messages[i + 1]
    const reply = next?.role === 'assistant' ? next : undefined
    const userText = collapseText(msg.content, 100)
    const userSummary =
      userText || (msg.files.length > 0 ? attachmentLabel : '...')
    const replyRaw = reply ? collapseText(getReplyText(reply), 160) : ''
    const replySummary = replyRaw || noAnswerLabel
    turns.push({
      index: turns.length,
      userMessageId: msg.id,
      createdAt: msg.createdAt,
      userSummary,
      replySummary,
    })
  }
  return turns
}

const buildRailNodes = (turnCount: number): RailNode[] => {
  if (turnCount <= COMPACT_TURN_THRESHOLD) {
    return Array.from({ length: turnCount }, (_, index) => ({
      kind: 'dot',
      startTurn: index,
      endTurn: index,
      focusTurn: index,
    }))
  }
  const bucketCount = Math.min(MAX_GROUP_BUCKETS, turnCount)
  const nodes: RailNode[] = []
  for (let i = 0; i < bucketCount; i++) {
    const startTurn = Math.floor((i * turnCount) / bucketCount)
    const endTurn = Math.max(startTurn, Math.floor(((i + 1) * turnCount) / bucketCount) - 1)
    const span = endTurn - startTurn + 1
    nodes.push({
      kind: span >= 3 ? 'pill' : 'dot',
      startTurn,
      endTurn,
      focusTurn: startTurn,
    })
  }
  return nodes
}

/**
 * 仿 Antigravity 的对话轮次时间线轨道：
 * - 轮次适中时显示逐轮圆点，悬停/点击弹出单轮预览气泡（提问 + 回答摘要 + N of M）
 * - 超长对话时自动收缩为分组胶囊，弹出带时间与提问摘要的可滚动目录卡，点击直达对应轮次
 */
export const ConversationTimeline = memo(function ConversationTimeline({
  sessionId,
  title,
  turns,
  activeTurnIndex,
  isMobile,
  onJumpToTurn,
}: {
  sessionId: string
  title: string
  turns: TimelineTurn[]
  activeTurnIndex: number
  isMobile: boolean
  onJumpToTurn: (messageId: string) => void
}) {
  const t = useTranslate()
  const locale = t('latestReminderLanguage') === '中文' ? 'zh-CN' : 'en-US'
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null)

  const compactMode = turns.length > COMPACT_TURN_THRESHOLD
  const nodes = useMemo(() => buildRailNodes(turns.length), [turns.length])

  const clampedActive =
    turns.length > 0 ? Math.max(0, Math.min(turns.length - 1, activeTurnIndex)) : 0
  const previewTurnIndex =
    hoveredTurn !== null && hoveredTurn >= 0 && hoveredTurn < turns.length
      ? hoveredTurn
      : clampedActive
  const previewTurn = turns[previewTurnIndex]

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleClose = () => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      setHoveredTurn(null)
    }, 180)
  }

  useEffect(() => {
    setOpen(false)
    setHoveredTurn(null)
    clearCloseTimer()
  }, [sessionId])

  useEffect(() => () => clearCloseTimer(), [])

  useEffect(() => {
    if (!open) {
      return
    }
    const unregisterBack = registerAndroidBackHandler(70, () => {
      setOpen(false)
      return true
    })
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setHoveredTurn(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setHoveredTurn(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      unregisterBack()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 打开目录总览卡时，自动把列表滚到当前预览/阅读的轮次附近
  useEffect(() => {
    if (!open || !compactMode || !listRef.current) {
      return
    }
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-timeline-turn="${previewTurnIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, compactMode, previewTurnIndex])

  if (turns.length < 2 || !previewTurn) {
    return null
  }

  const jumpAndClose = (messageId: string) => {
    onJumpToTurn(messageId)
    if (isMobile) {
      setOpen(false)
      setHoveredTurn(null)
    }
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      aria-label={t('timelineNavLabel')}
      onMouseEnter={() => {
        if (!isMobile) {
          clearCloseTimer()
          setOpen(true)
        }
      }}
      onMouseLeave={() => {
        if (!isMobile) {
          scheduleClose()
        }
      }}
    >
      {open ? (
        <div className={styles.popover} role="region" aria-label={t('timelineNavLabel')}>
          {compactMode ? (
            <>
              <div className={styles.overviewHeader}>
                <div className={styles.overviewTitle}>{title || t('untitledChat')}</div>
                <div className={styles.overviewSub}>
                  {formatRangeHeader(turns[0].createdAt, turns[turns.length - 1].createdAt, locale)}{' '}
                  · {t('timelineTurns', { count: turns.length })}
                </div>
              </div>
              <div ref={listRef} className={styles.overviewList}>
                {turns.map((turn) => (
                  <button
                    key={turn.userMessageId}
                    type="button"
                    data-timeline-turn={turn.index}
                    className={clsx(
                      styles.overviewRow,
                      turn.index === clampedActive && styles.overviewRowActive
                    )}
                    onClick={() => jumpAndClose(turn.userMessageId)}
                  >
                    <span className={styles.overviewTime}>{formatClock(turn.createdAt)}</span>
                    <span className={styles.overviewPrompt}>{turn.userSummary}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button
              type="button"
              className={styles.singleCard}
              onClick={() => jumpAndClose(previewTurn.userMessageId)}
            >
              <div className={styles.singleQuestion}>{previewTurn.userSummary}</div>
              <div className={styles.singleAnswer}>{previewTurn.replySummary}</div>
              <div className={styles.singleMeta}>
                <span>
                  {t('timelineTurnIndex', {
                    current: previewTurn.index + 1,
                    total: turns.length,
                  })}
                </span>
                <span>{formatFullDateTime(previewTurn.createdAt, locale)}</span>
              </div>
            </button>
          )}
        </div>
      ) : null}

      <div className={clsx(styles.rail, open && styles.railActive)}>
        {nodes.map((node) => {
          const isCurrent = clampedActive >= node.startTurn && clampedActive <= node.endTurn
          const isFocused =
            open && previewTurnIndex >= node.startTurn && previewTurnIndex <= node.endTurn
          return (
            <button
              key={`${node.startTurn}-${node.endTurn}`}
              type="button"
              className={clsx(
                styles.nodeBtn,
                isCurrent && styles.nodeBtnCurrent,
                isFocused && styles.nodeBtnFocused
              )}
              aria-label={turns[node.focusTurn]?.userSummary ?? t('timelineNavLabel')}
              onMouseEnter={() => {
                if (!isMobile) {
                  clearCloseTimer()
                  setHoveredTurn(node.focusTurn)
                  setOpen(true)
                }
              }}
              onClick={() => {
                if (isMobile) {
                  if (!open) {
                    setHoveredTurn(node.focusTurn)
                    setOpen(true)
                    return
                  }
                  if (compactMode) {
                    setHoveredTurn(node.focusTurn)
                    return
                  }
                  if (hoveredTurn !== node.focusTurn) {
                    setHoveredTurn(node.focusTurn)
                    return
                  }
                  jumpAndClose(turns[node.focusTurn].userMessageId)
                } else {
                  jumpAndClose(turns[node.focusTurn].userMessageId)
                }
              }}
            >
              <span className={node.kind === 'pill' ? styles.pill : styles.dot} />
            </button>
          )
        })}
      </div>
    </div>
  )
})
