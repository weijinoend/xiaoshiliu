import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import * as db from '../../services/chat/db.js'
import { selectSessionAndReveal, useChatStore } from '../../services/chat/store.js'
import type { Message, Session } from '../../services/chat/types.js'
import {
  IconChatBubbleOutline16,
  IconChevronLeftOutline16,
  IconCloseOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import {
  closeSessionSearch,
  setSearchScrollTarget,
  useSessionSearch,
} from './sessionSearchState.js'
import styles from './SessionSearchOverlay.module.css'

const DAY = 86_400_000
const MAX_HITS = 150

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

const extractMessageText = (message: Message): string =>
  message.role === 'user'
    ? message.content
    : message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

type HitItem = {
  key: string
  sessionId: string
  messageId?: string
  title: string
  timestamp: number
  text: string
  isTitleOnly?: boolean
}

const formatHitDate = (
  timestamp: number,
  now: number,
  todayLabel: string,
  yesterdayLabel: string
) => {
  const diff = Math.floor((startOfDay(now) - startOfDay(timestamp)) / DAY)
  if (diff <= 0) {
    return todayLabel
  }
  if (diff === 1) {
    return yesterdayLabel
  }
  const date = new Date(timestamp)
  const month = date.getMonth() + 1
  const day = String(date.getDate()).padStart(2, '0')
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${month}-${day}`
  }
  return `${date.getFullYear()}-${month}-${day}`
}

const renderHighlightedSnippet = (raw: string, query: string) => {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) {
    return null
  }
  const lower = flat.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx < 0) {
    return <span>{flat}</span>
  }
  const start = Math.max(0, idx - 14)
  const end = Math.min(flat.length, idx + query.length + 56)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < flat.length ? '...' : ''
  const before = flat.slice(start, idx)
  const match = flat.slice(idx, idx + query.length)
  const after = flat.slice(idx + query.length, end)
  return (
    <span>
      {prefix}
      {before}
      <mark className={styles.hitKeyword}>{match}</mark>
      {after}
      {suffix}
    </span>
  )
}

/** DeepSeek 风格全屏会话搜索页：展开动画 + 标题/正文多选 + 上下文高亮列表 + 点击定位到对应消息 */
export const SessionSearchOverlay = () => {
  const open = useSessionSearch((state) => state.open)
  if (!open) {
    return null
  }
  return <SearchOverlayContent />
}

const SearchOverlayContent = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const sessionCache = useChatStore((state) => state.sessionCache)
  const [query, setQuery] = useState('')
  const [searchTitle, setSearchTitle] = useState(true)
  const [searchBody, setSearchBody] = useState(true)
  const [allSessionsMap, setAllSessionsMap] = useState<Map<string, Session> | null>(null)
  const [scanning, setScanning] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [now] = useState(Date.now)

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40)
    const unregisterBack = registerAndroidBackHandler(120, closeSessionSearch)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSessionSearch()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      unregisterBack()
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setScanning(true)
    void db
      .loadAllSessions()
      .then((list) => {
        if (cancelled) {
          return
        }
        setAllSessionsMap(new Map(list.map((item) => [item.id, item])))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setScanning(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessions])

  const trimmed = query.trim().toLowerCase()

  const hits = useMemo(() => {
    if (!trimmed) {
      return []
    }
    const items: HitItem[] = []
    for (const summary of sessions) {
      if (items.length >= MAX_HITS) {
        break
      }
      const title = summary.title || t('untitledChat')
      const titleMatches = searchTitle && title.toLowerCase().includes(trimmed)
      const fullSession =
        (Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : undefined) ??
        allSessionsMap?.get(summary.id)

      let bodyHitCount = 0
      if (searchBody && fullSession) {
        for (let i = fullSession.messages.length - 1; i >= 0; i -= 1) {
          const message = fullSession.messages[i]
          const text = extractMessageText(message)
          if (text && text.toLowerCase().includes(trimmed)) {
            items.push({
              key: `${summary.id}:${message.id}`,
              sessionId: summary.id,
              messageId: message.id,
              title,
              timestamp: message.createdAt || summary.updatedAt,
              text,
            })
            bodyHitCount += 1
            if (items.length >= MAX_HITS) {
              break
            }
          }
        }
      }

      if (titleMatches && bodyHitCount === 0 && items.length < MAX_HITS) {
        const preview = fullSession?.messages[0] ? extractMessageText(fullSession.messages[0]) : ''
        items.push({
          key: `${summary.id}:title`,
          sessionId: summary.id,
          title,
          timestamp: summary.updatedAt,
          text: preview || t('searchResultTitleMatch'),
          isTitleOnly: true,
        })
      }
    }
    return items
  }, [sessions, sessionCache, allSessionsMap, trimmed, searchTitle, searchBody, t])

  const handleSelectHit = (hit: HitItem) => {
    if (hit.messageId) {
      setSearchScrollTarget(hit.sessionId, hit.messageId)
    }
    selectSessionAndReveal(hit.sessionId, hit.messageId)
    closeSessionSearch()
    closeMobileSider()
  }

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={t('searchSessionsPlaceholder')}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.backButton}
          aria-label={t('close')}
          onClick={closeSessionSearch}
        >
          <IconChevronLeftOutline16 />
        </button>
        <div className={styles.inputPill}>
          <span className={styles.inputIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            ref={inputRef}
            type="search"
            className={styles.input}
            placeholder={t('searchSessionsPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className={styles.clearBtn}
              aria-label={t('close')}
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.scopeBar}>
        <button
          type="button"
          className={clsx(styles.scopeChip, searchTitle && styles.scopeChipActive)}
          aria-pressed={searchTitle}
          onClick={() => {
            if (searchTitle && !searchBody) {
              return
            }
            setSearchTitle((value) => !value)
          }}
        >
          {t('searchScopeTitle')}
        </button>
        <button
          type="button"
          className={clsx(styles.scopeChip, searchBody && styles.scopeChipActive)}
          aria-pressed={searchBody}
          onClick={() => {
            if (searchBody && !searchTitle) {
              return
            }
            setSearchBody((value) => !value)
          }}
        >
          {t('searchScopeBody')}
        </button>
      </div>

      <div className={styles.results}>
        {trimmed && scanning && hits.length === 0 ? (
          <div className={styles.emptyState}>{t('searchSessionsScanning')}</div>
        ) : trimmed && hits.length === 0 ? (
          <div className={styles.emptyState}>{t('searchSessionsEmpty')}</div>
        ) : null}
        {hits.map((hit) => (
          <button
            key={hit.key}
            type="button"
            className={styles.hitItem}
            onClick={() => handleSelectHit(hit)}
          >
            <span className={styles.hitIcon}>
              <IconChatBubbleOutline16 />
            </span>
            <div className={styles.hitBody}>
              <div className={styles.hitTop}>
                <span className={styles.hitTitle}>{hit.title}</span>
                <span className={styles.hitDate}>
                  {formatHitDate(
                    hit.timestamp,
                    now,
                    t('sessionHistoryTimelineLabelToday'),
                    t('sessionHistoryTimelineLabelYesterday')
                  )}
                </span>
              </div>
              <div className={styles.hitSnippet}>
                {hit.isTitleOnly
                  ? hit.text.replace(/\s+/g, ' ').trim()
                  : renderHighlightedSnippet(hit.text, trimmed)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>,
    document.body
  )
}
