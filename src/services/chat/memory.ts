import { formatDate } from '../../utils/format.js'
import { getVisibleMessages } from './branches.js'
import { loadSession } from './db.js'
import { getContextRounds, getReplyText } from './reply.js'
import type { Session, SessionSummary } from './types.js'

const MAX_MEMORY_CHARS = 2400
const USER_SNIPPET_MAX = 220
const ASSISTANT_SNIPPET_MAX = 360
const MAX_ROUNDS_PER_SESSION = 2
const RECENT_FALLBACK_LIMIT = 3
const MAX_CANDIDATE_SESSIONS = 60
const MAX_TOKENIZE_CHARS = 1200

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'have',
  'has',
  'are',
  'was',
  'were',
  'you',
  'your',
  'about',
  'into',
  'can',
  'how',
  'why',
  '什么',
  '怎么',
  '为什么',
  '可以',
  '请问',
  '一下',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '刚才',
  '之前',
  '以前',
  '昨天',
  '今天',
  '现在',
  '的',
  '了',
  '吗',
  '呢',
  '吧',
  '啊',
  '我',
  '你',
  '他',
  '她',
  '它',
  '是',
  '在',
  '有',
  '和',
  '就',
  '都',
  '还',
  '要',
  '会',
  '能',
])

type IndexedRound = {
  userText: string
  assistantText: string
  tokens: Set<string>
}

type IndexedSession = {
  id: string
  title: string
  updatedAt: number
  allowRefused: boolean
  titleTokens: Set<string>
  rounds: IndexedRound[]
  allTokens: Set<string>
}

const sessionIndexCache = new Map<string, IndexedSession>()

/** 中英文混合分词：英文/数字按词，中文按单字与二元词组，过滤常见停用词 */
const tokenize = (text: string): Set<string> => {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9_.-]{2,}/g)
  if (words) {
    for (const word of words) {
      if (!STOP_WORDS.has(word)) {
        tokens.add(word)
      }
    }
  }
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length; i++) {
        const ch = run[i]
        if (!STOP_WORDS.has(ch)) {
          tokens.add(ch)
        }
        if (i + 1 < run.length) {
          const bigram = run.slice(i, i + 2)
          if (!STOP_WORDS.has(bigram)) {
            tokens.add(bigram)
          }
        }
      }
    }
  }
  return tokens
}

const compactText = (text: string) => text.replace(/\s+/g, ' ').trim()

const clipSnippet = (text: string, maxLength: number, queryTokens: Set<string>): string => {
  const compact = compactText(text)
  if (compact.length <= maxLength) {
    return compact
  }
  const lower = compact.toLowerCase()
  let bestPos = -1
  for (const token of queryTokens) {
    if (token.length < 2) {
      continue
    }
    const idx = lower.indexOf(token)
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
      bestPos = idx
    }
  }
  if (bestPos <= Math.floor(maxLength * 0.4)) {
    return `${compact.slice(0, maxLength - 1)}…`
  }
  const start = Math.max(0, bestPos - Math.floor(maxLength * 0.35))
  const end = Math.min(compact.length, start + maxLength - 2)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < compact.length ? '…' : ''
  return `${prefix}${compact.slice(start, end)}${suffix}`
}

const indexSession = (session: Session, allowRefused: boolean): IndexedSession => {
  const visible = getVisibleMessages(session)
  const pairs = getContextRounds(visible, allowRefused)
  const title = session.title.trim()
  const titleTokens = tokenize(title)
  const allTokens = new Set<string>(titleTokens)
  const rounds: IndexedRound[] = []

  for (const [user, reply] of pairs) {
    const userText = compactText(user.content)
    const assistantText = compactText(getReplyText(reply))
    if (!userText && !assistantText) {
      continue
    }
    const tokens = tokenize(
      `${userText.slice(0, MAX_TOKENIZE_CHARS)}\n${assistantText.slice(0, MAX_TOKENIZE_CHARS)}`
    )
    for (const token of tokens) {
      allTokens.add(token)
    }
    rounds.push({ userText, assistantText, tokens })
  }

  return {
    id: session.id,
    title,
    updatedAt: session.updatedAt,
    allowRefused,
    titleTokens,
    rounds,
    allTokens,
  }
}

const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${formatDate(date)} ${hh}:${mm}`
}

const scoreTokenSet = (
  queryTokens: Set<string>,
  target: Set<string>,
  idf: Map<string, number>
): number => {
  let score = 0
  for (const token of queryTokens) {
    if (target.has(token)) {
      const weight = (idf.get(token) ?? 1) * (token.length >= 2 ? 1.5 : 0.7)
      score += weight
    }
  }
  return score
}

const RECALL_INTENT_RE =
  /之前|以前|上次|昨天|前几天|过往|历史|聊过|提过|说过|记得|回忆|remember|last time|previous|earlier/i

/**
 * 检索历史会话，生成本轮用户消息里的跨对话记忆参考文本。
 * 注意：这类每轮都会变化的内容不能放进 system，否则整段前缀 KV 缓存全部失效。
 * - scope = 'all'：按词元相关性（含 IDF 权重）检索，仅在明确带有回忆意图或足够长的问题时才兜底近况，避免对「你好」「hi」无谓注入。
 * - scope = 'selected'：仅在用户多选指定的互通会话范围内共享记忆。
 */
export const buildCrossChatMemory = async ({
  currentSessionId,
  query,
  sessions,
  sessionCache,
  maxSessions,
  allowRefused,
  scope = 'all',
  selectedSessionIds = [],
  signal,
}: {
  currentSessionId: string
  query: string
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  maxSessions: number
  allowRefused: boolean
  scope?: 'all' | 'selected'
  selectedSessionIds?: string[]
  signal?: AbortSignal
}): Promise<string> => {
  const activeIds = new Set(sessions.map((item) => item.id))
  for (const cachedId of sessionIndexCache.keys()) {
    if (!activeIds.has(cachedId)) {
      sessionIndexCache.delete(cachedId)
    }
  }

  const selectedFilter = scope === 'selected' ? new Set(selectedSessionIds) : null
  const allCandidates = sessions.filter(
    (item) => item.id !== currentSessionId && (!selectedFilter || selectedFilter.has(item.id))
  )
  const candidates =
    scope === 'selected'
      ? allCandidates
      : [...allCandidates]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_CANDIDATE_SESSIONS)
  if (candidates.length === 0 || maxSessions <= 0) {
    return ''
  }

  // 优先复用内存缓存，仅按需逐条读取缺失或更新过的候选会话，避免超大库下 loadAllSessions 卡死或内存溢出。
  const missingIds: string[] = []
  for (const summary of candidates) {
    const inMemory = Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : undefined
    if (inMemory) {
      const cached = sessionIndexCache.get(summary.id)
      if (
        !cached ||
        cached.updatedAt !== inMemory.updatedAt ||
        cached.allowRefused !== allowRefused
      ) {
        sessionIndexCache.set(summary.id, indexSession(inMemory, allowRefused))
      }
      continue
    }
    const cached = sessionIndexCache.get(summary.id)
    if (!cached || cached.updatedAt !== summary.updatedAt || cached.allowRefused !== allowRefused) {
      missingIds.push(summary.id)
    }
  }

  for (const id of missingIds) {
    if (signal?.aborted) {
      return ''
    }
    const session = await loadSession(id)
    if (signal?.aborted) {
      return ''
    }
    if (session && session.id !== currentSessionId && activeIds.has(session.id)) {
      sessionIndexCache.set(session.id, indexSession(session, allowRefused))
    }
  }

  const docs: IndexedSession[] = []
  for (const summary of candidates) {
    const doc = sessionIndexCache.get(summary.id)
    if (doc && doc.rounds.length > 0) {
      docs.push(doc)
    }
  }
  if (docs.length === 0) {
    return ''
  }

  const queryTokens = tokenize(query)
  const docFreq = new Map<string, number>()
  for (const token of queryTokens) {
    let count = 0
    for (const doc of docs) {
      if (doc.allTokens.has(token)) {
        count++
      }
    }
    docFreq.set(token, count)
  }
  const idf = new Map<string, number>()
  for (const [token, df] of docFreq) {
    idf.set(token, Math.log((docs.length + 1) / (df + 0.5)) + 0.5)
  }

  const now = Date.now()
  const ranked = docs
    .map((doc) => {
      const titleScore = scoreTokenSet(queryTokens, doc.titleTokens, idf) * 2
      const bodyScore = scoreTokenSet(queryTokens, doc.allTokens, idf)
      const relevance = titleScore + bodyScore
      const ageDays = Math.max(0, (now - doc.updatedAt) / 86_400_000)
      const recency = Math.exp(-ageDays / 7)
      return { doc, relevance, score: relevance + (relevance > 0 ? recency * 0.5 : 0) }
    })
    .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt)

  const selected: IndexedSession[] = []
  const selectedIds = new Set<string>()

  const effectiveLimit =
    scope === 'selected' ? Math.max(maxSessions, candidates.length) : maxSessions
  for (const item of ranked) {
    if (selected.length >= effectiveLimit || item.relevance <= 0) {
      break
    }
    selected.push(item.doc)
    selectedIds.add(item.doc.id)
  }

  // 指定互通模式下，选中的历史会话始终纳入共享；全部模式下，仅在明确带回忆意图或实词较多时才兜底近期会话，避免对「hi」「你好」无效召回。
  const allowRecentFallback =
    scope === 'selected' || RECALL_INTENT_RE.test(query) || queryTokens.size >= 4
  const recentLimit =
    scope === 'selected' ? effectiveLimit : Math.min(maxSessions, RECENT_FALLBACK_LIMIT)
  if (allowRecentFallback && selected.length < recentLimit) {
    const byRecent = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const doc of byRecent) {
      if (selected.length >= recentLimit) {
        break
      }
      if (!selectedIds.has(doc.id)) {
        selected.push(doc)
        selectedIds.add(doc.id)
      }
    }
  }

  if (selected.length === 0) {
    return ''
  }

  const header =
    '以下是用户过往其他对话中的记忆记录（仅在确实与当前问题相关时结合参考；若用户询问过往聊过的内容可直接引用，若不相关则忽略）：'
  const blocks: string[] = [header]
  let totalChars = header.length

  selected.forEach((doc, idx) => {
    const scoredRounds = doc.rounds
      .map((round, roundIndex) => ({
        round,
        roundIndex,
        score: scoreTokenSet(queryTokens, round.tokens, idf),
      }))
      .sort((a, b) => b.score - a.score || b.roundIndex - a.roundIndex)

    const pickedRounds = scoredRounds
      .slice(0, MAX_ROUNDS_PER_SESSION)
      .sort((a, b) => a.roundIndex - b.roundIndex)

    const title = doc.title || '未命名对话'
    const lines: string[] = [`[${idx + 1}] 对话《${title}》（${formatDateTime(doc.updatedAt)}）`]
    for (const { round } of pickedRounds) {
      if (round.userText) {
        lines.push(`- 用户：${clipSnippet(round.userText, USER_SNIPPET_MAX, queryTokens)}`)
      }
      if (round.assistantText) {
        lines.push(
          `- 助手：${clipSnippet(round.assistantText, ASSISTANT_SNIPPET_MAX, queryTokens)}`
        )
      }
    }
    const block = lines.join('\n')
    if (totalChars + block.length + 2 > MAX_MEMORY_CHARS && blocks.length > 1) {
      return
    }
    blocks.push(block)
    totalChars += block.length + 2
  })

  return blocks.length > 1 ? blocks.join('\n\n') : ''
}
