import { create } from 'zustand'
import { translate } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import {
  blobToDataUrl,
  generateImage,
  recognizeWithOpenAIVision,
  streamOpenAIMessage,
  streamResponsesMessage,
} from '../api/openai.js'
import { getApiOrigin } from '../api/origin.js'
import type { ChatModel, CreateMessageRequest, MessageUsage } from '../api/types.js'
import {
  extractFileIds,
  getFileErrorCode,
  isContextOverflowError,
  isRetryableApiError,
  isTooManyImagesError,
  parseMessageErrorLocation,
} from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { matchesRefusalKeyword, setImageGen, useSettings } from '../settings.js'
import { getReplyModeInstruction } from '../replyModes.js'
import { toggleReadAloud } from '../speech/readAloud.js'
import { recordTurnTokenUsage } from '../tokenUsage.js'
import {
  appendBranch,
  deleteBranchFrom,
  forkPathMessages,
  getVisibleMessages,
  normalizeSession,
  revealMessageBranch,
  selectVersion,
} from './branches.js'
import * as db from './db.js'
import {
  addDraftFiles,
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { buildCrossChatMemory } from './memory.js'
import { extractMemoriesFromTurn, formatSavedMemories } from './savedMemory.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  settleReply,
  toRequestMessagesWithSources,
  type RequestMessageSource,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核级别 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 根据配置组装服务端工具声明：read_url 与 web_search 各自独立开关。 */
const serverTools = (search: boolean, readUrl: boolean): CreateMessageRequest['tools'] => {
  const tools: NonNullable<CreateMessageRequest['tools']> = []
  if (readUrl) {
    tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
  }
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => {
    const aPinned = typeof a.pinnedAt === 'number' && a.pinnedAt > 0
    const bPinned = typeof b.pinnedAt === 'number' && b.pinnedAt > 0
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1
    }
    if (aPinned && bPinned && a.pinnedAt !== b.pinnedAt) {
      return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    }
    return b.updatedAt - a.updatedAt
  })

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.pinnedAt === b.pinnedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: model.trim() || MODEL,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 命中本地拒答关键词时直接生成拒答消息，不发起 API 请求。 */
const createRefusedReply = (): AssistantMessage => {
  const { refusalMessage, model } = useSettings.getState()
  const text = refusalMessage.trim() || translate('replyRefused')
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: model.trim() || MODEL,
    thinking: false,
    search: false,
    prefix: false,
    status: 'done',
    stopReason: 'refusal',
    blocks: [{ type: 'text', text, isTemplate: true }],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  const { keepRefusedContent } = useSettings.getState()
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt, undefined, keepRefusedContent)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const selectSessionAndReveal = (id: string, messageId?: string) => {
  if (get().importingHistory || !get().sessions.some((session) => session.id === id)) {
    return
  }
  touchSession(id)
  set({ activeId: id })
  void ensureSessionLoaded(id).then(() => {
    if (messageId && !getStreamController(id)) {
      updateSession(id, (session) => revealMessageBranch(session, messageId))
    }
  })
  trimSessionCache()
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

export const togglePinSession = (id: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const currentSummary = get().sessions.find((session) => session.id === id)
  if (!currentSummary) {
    return
  }
  const nextPinnedAt = currentSummary.pinnedAt ? undefined : Date.now()
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, pinnedAt: nextPinnedAt }))
    persist(id)
  } else {
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, pinnedAt: nextPinnedAt } : session
        )
      ),
    }))
    void db.setSessionPinned(id, nextPinnedAt).catch(db.reportStorageError('pin session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

type SubmittedPromptFile = {
  id: string
  serverId: string | null
  name: string
  size: number
  isImage: boolean
  mimeType: string
  blob?: Blob
}

const submitPrompt = (
  targetSessionId: string | null,
  text: string,
  files: SubmittedPromptFile[],
  options: { voiceCall?: boolean; imageGen?: boolean } = {}
): { sessionId: string; replyId: string } | null => {
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return null
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: sortSessions([toSessionSummary(session), ...state.sessions]),
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return null
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const localRefused = matchesRefusalKeyword(question.content)
  const reply = localRefused ? createRefusedReply() : createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  const blobs = files.flatMap(({ id, blob }) => (blob ? [{ id, blob }] : []))
  if (blobs.length > 0) {
    pendingFiles.set(sessionId, [...(pendingFiles.get(sessionId) ?? []), ...blobs])
  }
  persist(sessionId)
  if (!localRefused) {
    if (options.imageGen) {
      const sourceFileIds = files.filter((file) => file.isImage).map((file) => file.id)
      void runImageGeneration(sessionId, reply, text, sourceFileIds)
    } else {
      void streamReply(sessionId, reply, { history, question, voiceCall: options.voiceCall })
    }
  }
  return { sessionId, replyId: reply.id }
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { imageGen, imageGenChannel } = useSettings.getState()
  const submitted = submitPrompt(targetSessionId, prepared.text, prepared.files, {
    imageGen:
      imageGen &&
      imageGenChannel.enabled &&
      Boolean(imageGenChannel.model.trim()) &&
      prepared.files.every((file) => file.isImage) &&
      prepared.text.trim() !== '',
  })
  if (!submitted) {
    return false
  }
  clearSentDraft(targetSessionId)
  return true
}

/** 连续语音通话发送提问（可附带实时画面帧）；null 表示新建会话。 */
export const sendVoicePrompt = (
  targetSessionId: string | null,
  content: string,
  files: SubmittedPromptFile[] = []
): { sessionId: string; replyId: string } | null => {
  const text = content.trim()
  if ((!text && files.length === 0) || get().importingHistory || !get().ready) {
    return null
  }
  return submitPrompt(targetSessionId, text, files, { voiceCall: true })
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const localRefused = matchesRefusalKeyword(question.content)
  const reply = localRefused ? createRefusedReply() : createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  if (!localRefused) {
    void streamReply(sessionId, reply, { history, question })
  }
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const localRefused = matchesRefusalKeyword(question.content)
  const reply = localRefused ? createRefusedReply() : createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  if (!localRefused) {
    void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  }
  return true
}

/** 编辑助手回复并形成新的同父分支版本；旧回答与后续分支仍可切回。 */
export const editAssistantMessage = (
  sessionId: string,
  messageId: string,
  content: string
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'assistant' || !text) {
    return false
  }
  const edited: AssistantMessage = {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: previous.model,
    thinking: previous.thinking,
    search: previous.search,
    latestReminder: previous.latestReminder,
    prefix: true,
    status: 'done',
    stopReason: 'end_turn',
    blocks: [{ type: 'text', text }],
  }
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [edited]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 删除指定消息及其向下衍生的分支；若整个会话已空则顺便删除该空会话。 */
export const deleteMessageBranch = (sessionId: string, messageId: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return false
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const next = deleteBranchFrom(current, messageId)
  if (next === current) {
    return false
  }
  if (next.messages.length === 0) {
    void removeSession(sessionId)
    return true
  }
  updateSession(sessionId, () => ({
    ...next,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  return true
}

/** 从指定消息为止的上下文分叉出一个独立新对话，并立即切换过去。 */
export const forkSessionFromMessage = (sessionId: string, messageId: string): string | null => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return null
  }
  const source = getSession(sessionId)
  if (!source) {
    return null
  }
  const forkedMessages = forkPathMessages(source, messageId, createId)
  if (forkedMessages.length === 0) {
    return null
  }
  const now = Date.now()
  const baseTitle = source.title.trim()
  const suffix = translate('branchTitleSuffix')
  const title = baseTitle ? `${baseTitle} · ${suffix}` : ''
  const nextSession: Session = {
    id: createId(),
    title,
    createdAt: now,
    updatedAt: now,
    rootMessageId: forkedMessages[0].id,
    messages: forkedMessages,
  }
  touchSession(nextSession.id)
  set((state) => ({
    sessions: sortSessions([toSessionSummary(nextSession), ...state.sessions]),
    sessionCache: { ...state.sessionCache, [nextSession.id]: nextSession },
    activeId: nextSession.id,
  }))
  persist(nextSession.id)
  return nextSession.id
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  const { thinking, search, model, allowRefusedContext } = useSettings.getState()
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous, allowRefusedContext)
  ) {
    return
  }
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? (model.trim() || MODEL),
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  voiceCall?: boolean
}

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

const SKIPPED_HISTORY_FILES_KEY = 'deepjeek_skipped_history_files'
const MAX_SKIPPED_HISTORY_FILES = 500
const MAX_HISTORY_HEAL_ATTEMPTS = 8

const getSkippedHistoryFileIds = (): Set<string> => {
  try {
    const raw = localStorage.getItem(SKIPPED_HISTORY_FILES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

const markSkippedHistoryFileIds = (ids: string[]) => {
  if (ids.length === 0) {
    return
  }
  try {
    const set = getSkippedHistoryFileIds()
    for (const id of ids) {
      if (id) {
        set.add(id)
      }
    }
    const list = [...set].slice(-MAX_SKIPPED_HISTORY_FILES)
    localStorage.setItem(SKIPPED_HISTORY_FILES_KEY, JSON.stringify(list))
  } catch {
    // ignore storage quota errors
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (
  sessionId: string,
  request: Request,
  signal: AbortSignal,
  skippedHistoryFileIds: ReadonlySet<string> = new Set()
) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const { allowRefusedContext } = useSettings.getState()
  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history, allowRefusedContext).toReversed()) {
    for (const file of user.files) {
      if (
        !file.serverId &&
        !skippedHistoryFileIds.has(file.id) &&
        !serverIds.has(file.id) &&
        !pending.has(file.id)
      ) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  const { allowRefusedContext } = useSettings.getState()
  for (const [user] of getContextRounds(request.history, allowRefusedContext)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

const TEXT_MIME_RE =
  /^text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|csv|markdown)/i
const TEXT_EXT_RE =
  /\.(txt|md|markdown|json|csv|tsv|yaml|yml|xml|html|htm|css|js|jsx|ts|tsx|py|go|rs|java|c|cpp|h|hpp|sh|sql|log|ini|toml|env)$/i

const findLocalBlob = async (sessionId: string, fileId: string): Promise<Blob | undefined> => {
  const pending = pendingFiles.get(sessionId)?.find((item) => item.id === fileId)?.blob
  return pending ?? (await db.loadFile(fileId))
}

/**
 * DeepSeek 原生 Files API 对 user_data document 的解析能力有限。
 * 文本、代码、CSV 等可本地直读的文件直接并入本轮用户消息，确保模型一定能看到内容；
 * PDF / Word / PPT 等版面文档仍交给服务端 document 块解析。
 */
const extractNativeTextAttachments = async (
  sessionId: string,
  question: UserMessage,
  signal: AbortSignal
): Promise<UserMessage> => {
  const stripped = new Set<string>()
  const notes: string[] = []
  let remaining = 24_000

  for (const file of question.files) {
    signal.throwIfAborted()
    if (file.isImage || remaining <= 0) {
      continue
    }
    const textReadable = TEXT_MIME_RE.test(file.mimeType) || TEXT_EXT_RE.test(file.name)
    if (!textReadable || file.size > 512 * 1024) {
      continue
    }
    const blob = await findLocalBlob(sessionId, file.id)
    if (!blob) {
      continue
    }
    const content = (await blob.text()).replaceAll('\u0000', '').trim()
    if (!content) {
      continue
    }
    const excerpt = content.slice(0, Math.min(12_000, remaining))
    notes.push(`[文件：${file.name}]\n${excerpt}`)
    remaining -= excerpt.length
    stripped.add(file.id)
  }

  if (stripped.size === 0) {
    return question
  }
  return {
    ...question,
    content: [question.content, ...notes].filter(Boolean).join('\n\n'),
    files: question.files.filter((file) => !stripped.has(file.id)),
  }
}

/**
 * 读取并预处理本轮及历史附件（供 OpenAI 兼容或自定义图片识别/文字识别渠道使用）：
 * - 自定义图片识别渠道：用外部视觉模型把图片转为文字描述并附加到提问；
 * - 自定义文字识别渠道 / OpenAI 内联：把纯文本文件或图片数据转为请求内联块。
 */
const prepareInlineAttachments = async (
  sessionId: string,
  request: Request,
  signal: AbortSignal
): Promise<{
  question: UserMessage
  inlineImages: Map<string, string>
  inlineTexts: Map<string, string>
}> => {
  const settings = useSettings.getState()
  const inlineImages = new Map<string, string>()
  const inlineTexts = new Map<string, string>()
  const extraNotes: string[] = []
  const strippedFileIds = new Set<string>()

  const allFiles: FileAttachment[] = [...request.question.files]
  for (const [user] of getContextRounds(request.history, settings.allowRefusedContext)) {
    allFiles.push(...user.files)
  }

  for (const file of allFiles) {
    signal.throwIfAborted()
    const key = file.serverId ?? file.id
    const isCurrentQuestionFile = request.question.files.some((f) => f.id === file.id)
    const blob = await findLocalBlob(sessionId, file.id)
    if (!blob) {
      continue
    }

    if (file.isImage) {
      const dataUrl = await blobToDataUrl(blob)
      if (settings.visionChannel.mode === 'custom' && isCurrentQuestionFile) {
        const visionKey = settings.visionChannel.apiKey.trim() || settings.apiKey || ''
        const visionOrigin = settings.visionChannel.baseUrl.trim() || getApiOrigin()
        const visionModel = settings.visionChannel.model.trim() || settings.model
        const desc = await recognizeWithOpenAIVision({
          baseUrl: visionOrigin,
          apiKey: visionKey,
          model: visionModel,
          prompt: `请详细识别并描述这张图片（${file.name}）中的关键内容、文字与细节，供后续对话回答使用。`,
          dataUrl,
          signal,
        })
        if (desc) {
          extraNotes.push(`[图片识别（${file.name}）：${desc}]`)
        }
        strippedFileIds.add(file.id)
      } else if (settings.chatProtocol !== 'deepseek') {
        inlineImages.set(key, dataUrl)
      }
      continue
    }

    // 非图片文件（文档 / 文字识别）
    const isTextReadable = TEXT_MIME_RE.test(file.mimeType) || TEXT_EXT_RE.test(file.name)
    if (settings.ocrChannel.mode === 'custom' && isCurrentQuestionFile) {
      if (isTextReadable && blob.size <= 512 * 1024) {
        const content = await blob.text()
        extraNotes.push(`[文件文本（${file.name}）：\n${content.slice(0, 12000)}]`)
      } else {
        const ocrKey = settings.ocrChannel.apiKey.trim() || settings.apiKey || ''
        const ocrOrigin = settings.ocrChannel.baseUrl.trim() || getApiOrigin()
        const ocrModel = settings.ocrChannel.model.trim() || settings.model
        const dataUrl = await blobToDataUrl(blob)
        const text = await recognizeWithOpenAIVision({
          baseUrl: ocrOrigin,
          apiKey: ocrKey,
          model: ocrModel,
          prompt: `请完整提取并识别文件「${file.name}」中的所有文字内容。`,
          dataUrl,
          signal,
        })
        if (text) {
          extraNotes.push(`[文字识别（${file.name}）：${text}]`)
        }
      }
      strippedFileIds.add(file.id)
    } else if (settings.chatProtocol !== 'deepseek' && isTextReadable && blob.size <= 512 * 1024) {
      const content = await blob.text()
      inlineTexts.set(key, `[文件：${file.name}]\n${content.slice(0, 12000)}`)
    }
  }

  const question: UserMessage =
    extraNotes.length === 0 && strippedFileIds.size === 0
      ? request.question
      : {
          ...request.question,
          content: [request.question.content, ...extraNotes].filter(Boolean).join('\n\n'),
          files: request.question.files.filter((file) => !strippedFileIds.has(file.id)),
        }

  return { question, inlineImages, inlineTexts }
}

const IMAGE_GEN_TAG_RE = /<generate_image>([\s\S]*?)<\/generate_image>/i
const IMAGE_GEN_TAG_RE_G = /<generate_image>[\s\S]*?<\/generate_image>/gi

/** 使 sourceEntries 下标与 openai / responses 协议实际发送的 messages 数组精确对齐 */
const alignSourceEntriesForProtocol = (
  messages: CreateMessageRequest['messages'],
  sourceEntries: RequestMessageSource[],
  system: string,
  protocol: string
): RequestMessageSource[] => {
  if (protocol === 'deepseek') {
    return sourceEntries
  }
  const mapped: RequestMessageSource[] = []
  if (protocol !== 'responses' && system.trim()) {
    mapped.push({ kind: 'reminder' })
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const entry = sourceEntries[i]
    if (msg.role === 'latest_reminder') {
      continue
    }
    if (msg.role === 'assistant') {
      const hasText = msg.content.some((block) => block.type === 'text' && block.text)
      if (!hasText) {
        continue
      }
    }
    mapped.push(entry)
  }
  return mapped
}

const readImageDimensions = async (
  blob: Blob
): Promise<{ width: number; height: number } | null> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      const dims = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dims
    } catch {
      // 回退到 Image 元素读取尺寸
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/** 根据参考图宽高比自动匹配最接近的生图尺寸 */
const resolveSizeFromReference = async (blob: Blob): Promise<string | undefined> => {
  const dims = await readImageDimensions(blob)
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return undefined
  }
  const ratio = dims.width / dims.height
  if (ratio >= 1.6) {
    return '1792x1024'
  }
  if (ratio > 1.18) {
    return '1536x1024'
  }
  if (ratio >= 0.85) {
    return '1024x1024'
  }
  if (ratio >= 0.6) {
    return '1024x1536'
  }
  return '1024x1792'
}

const saveAndCreateImageBlock = async (
  prompt: string,
  signal: AbortSignal,
  sessionId?: string,
  sourceFileIds: string[] = [],
  sizeOverride?: string
): Promise<{
  fileId: string
  mimeType: string
  revisedPrompt?: string
  resolvedSize?: string
}> => {
  const settings = useSettings.getState()
  const { imageGenChannel } = settings
  const baseUrl = imageGenChannel.baseUrl.trim() || getApiOrigin()
  const apiKey = imageGenChannel.apiKey.trim() || settings.apiKey || ''
  const model = imageGenChannel.model.trim()
  if (!model) {
    throw new ApiError('protocol', '未配置生图模型名称，请在设置 → 模型与接口中填写生图模型')
  }
  const referenceImages: { blob: Blob; name: string; mimeType: string }[] = []
  if (sessionId && sourceFileIds.length > 0) {
    const session = getSession(sessionId)
    const fileMeta = new Map<string, FileAttachment>()
    if (session) {
      for (const m of session.messages) {
        if (m.role === 'user') {
          for (const f of m.files) {
            fileMeta.set(f.id, f)
          }
        }
      }
    }
    for (const id of sourceFileIds) {
      signal.throwIfAborted()
      const blob = await findLocalBlob(sessionId, id)
      if (!blob) {
        continue
      }
      const meta = fileMeta.get(id)
      referenceImages.push({
        blob,
        name: meta?.name ?? 'reference.png',
        mimeType: meta?.mimeType || blob.type || 'image/png',
      })
    }
  }
  let targetSize = (sizeOverride ?? imageGenChannel.size ?? '').trim()
  if (
    referenceImages.length > 0 &&
    (!targetSize || targetSize === 'auto' || targetSize === 'match')
  ) {
    targetSize = (await resolveSizeFromReference(referenceImages[0].blob)) ?? targetSize
  } else if (targetSize === 'match') {
    targetSize = 'auto'
  }
  const generated = await generateImage({
    baseUrl,
    apiKey,
    model,
    prompt,
    size: targetSize || undefined,
    protocol: imageGenChannel.protocol,
    preferResponses: settings.chatProtocol === 'responses',
    customHeadersRaw: imageGenChannel.customHeaders.trim() || settings.customHeaders,
    referenceImages,
    signal,
  })
  signal.throwIfAborted()
  if (sessionId && (deletingSessions.has(sessionId) || !getSession(sessionId))) {
    throw new DOMException('Aborted', 'AbortError')
  }
  const fileId = createId()
  await db.saveFiles([{ id: fileId, blob: generated.blob }])
  return {
    fileId,
    mimeType: generated.mimeType,
    revisedPrompt: generated.revisedPrompt,
    resolvedSize: targetSize || undefined,
  }
}

const updateImageBlockAt = (
  sessionId: string,
  messageId: string,
  blockIndex: number,
  updater: (
    block: Extract<AssistantMessage['blocks'][number], { type: 'image' }>
  ) => AssistantMessage['blocks'][number]
) => {
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) => {
      if (message.id !== messageId || message.role !== 'assistant') {
        return message
      }
      const target = message.blocks[blockIndex]
      if (target?.type !== 'image') {
        return message
      }
      const blocks = [...message.blocks]
      blocks[blockIndex] = updater(target)
      return { ...message, blocks }
    }),
  }))
}

/** 确认（或重试）一条待确认的生图块 */
export const confirmImageGeneration = async (
  sessionId: string,
  messageId: string,
  blockIndex: number,
  promptOverride?: string,
  sizeOverride?: string
) => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  const message = session?.messages.find((m) => m.id === messageId)
  const block = message?.role === 'assistant' ? message.blocks[blockIndex] : undefined
  if (block?.type !== 'image') {
    return
  }
  const prompt = (promptOverride ?? block.prompt ?? '').trim()
  if (!prompt) {
    return
  }
  const chosenSize = (
    sizeOverride ??
    block.size ??
    useSettings.getState().imageGenChannel.size
  ).trim()

  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  updateImageBlockAt(sessionId, messageId, blockIndex, (item) => ({
    ...item,
    prompt,
    size: chosenSize,
    status: 'generating',
    error: undefined,
  }))
  persist(sessionId)

  try {
    const result = await saveAndCreateImageBlock(
      prompt,
      controller.signal,
      sessionId,
      block.sourceFileIds ?? [],
      chosenSize
    )
    updateImageBlockAt(sessionId, messageId, blockIndex, (item) => ({
      type: 'image',
      fileId: result.fileId,
      mimeType: result.mimeType,
      prompt,
      size: result.resolvedSize ?? chosenSize,
      ...(item.sourceFileIds?.length ? { sourceFileIds: item.sourceFileIds } : {}),
      status: 'done',
    }))
  } catch (error) {
    if (controller.signal.aborted) {
      updateImageBlockAt(sessionId, messageId, blockIndex, (item) => ({
        ...item,
        status: 'pending_confirm',
      }))
    } else {
      const errMsg = error instanceof Error ? error.message : String(error)
      updateImageBlockAt(sessionId, messageId, blockIndex, (item) => ({
        ...item,
        status: 'error',
        error: errMsg,
      }))
    }
  } finally {
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}

/** 取消一条待确认的生图块 */
export const cancelImageGeneration = (sessionId: string, messageId: string, blockIndex: number) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  updateImageBlockAt(sessionId, messageId, blockIndex, (item) => ({
    ...item,
    status: 'cancelled',
    error: undefined,
  }))
  persist(sessionId)
}

/** 将已生成的图片带入输入框草稿作为参考图，并开启生图模式（方便继续图生图） */
export const reuseGeneratedImageInDraft = async (
  sessionId: string | null,
  fileId: string,
  mimeType: string
): Promise<boolean> => {
  const blob = await db.loadFile(fileId)
  if (!blob) {
    return false
  }
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png'
  const file = new File([blob], `reference-${fileId.slice(0, 8)}.${ext}`, {
    type: mimeType || 'image/png',
  })
  setImageGen(true)
  addDraftFiles(sessionId, [file], useSettings.getState().apiKey ?? '')
  return true
}

/** 直接生图模式：若开启了生图前确认，则先生成待确认卡片；否则直接调用生图渠道 */
const runImageGeneration = async (
  sessionId: string,
  initial: AssistantMessage,
  prompt: string,
  sourceFileIds: string[] = []
) => {
  const { imageGenChannel } = useSettings.getState()
  const initialSize =
    sourceFileIds.length > 0 && (!imageGenChannel.size || imageGenChannel.size === 'auto')
      ? 'match'
      : imageGenChannel.size || 'auto'

  if (imageGenChannel.requireConfirm) {
    const pendingReply: AssistantMessage = {
      ...initial,
      status: 'done',
      stopReason: 'end_turn',
      blocks: [
        {
          type: 'image',
          fileId: '',
          mimeType: 'image/png',
          prompt,
          size: initialSize,
          ...(sourceFileIds.length > 0 ? { sourceFileIds } : {}),
          status: 'pending_confirm',
        },
      ],
    }
    updateReply(sessionId, pendingReply)
    persist(sessionId)
    return
  }
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  try {
    const result = await saveAndCreateImageBlock(
      prompt,
      controller.signal,
      sessionId,
      sourceFileIds,
      initialSize
    )
    reply = {
      ...reply,
      status: 'done',
      stopReason: 'end_turn',
      blocks: [
        {
          type: 'image',
          fileId: result.fileId,
          mimeType: result.mimeType,
          prompt,
          size: result.resolvedSize ?? initialSize,
          ...(sourceFileIds.length > 0 ? { sourceFileIds } : {}),
          status: 'done',
        },
        ...(result.revisedPrompt ? [{ type: 'text' as const, text: result.revisedPrompt }] : []),
      ],
    }
  } catch (error) {
    if (controller.signal.aborted) {
      reply = settleReply(reply, 'stopped', Date.now())
    } else if (error instanceof ApiError) {
      reply = settleReply(reply, 'error', Date.now(), {
        kind: error.kind,
        message: error.message,
        status: error.status,
        localMessage: error.localMessage,
      })
    } else {
      reply = settleReply(reply, 'error', Date.now(), {
        kind: 'protocol',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}

/**
 * 请求并消费流：先补齐附件的 serverId（或预处理识别），再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let turnUsage: MessageUsage | undefined
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    const skippedHistoryFileIds = getSkippedHistoryFileIds()
    const skipRoundUserIds = new Set<string>()
    const stripReadLinkAssistantIds = new Set<string>()
    let dropLeadingRounds = 0
    let healAttempts = 0
    let fileRetryAttempt = 0

    for (;;) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      let builtSourceEntries: RequestMessageSource[] = []
      let builtRoundCount = 0
      try {
        const settings = useSettings.getState()
        const useDeepSeekFiles =
          settings.chatProtocol === 'deepseek' &&
          settings.visionChannel.mode === 'inherit' &&
          settings.ocrChannel.mode === 'inherit'
        const prepared = useDeepSeekFiles
          ? await prepareFiles(sessionId, request, controller.signal, skippedHistoryFileIds)
          : {
              history: request.history,
              question: request.question,
              prefix: request.prefix,
            }
        const preparedQuestion = useDeepSeekFiles
          ? await extractNativeTextAttachments(sessionId, prepared.question, controller.signal)
          : prepared.question
        const inlinePrepared = useDeepSeekFiles
          ? {
              question: preparedQuestion,
              inlineImages: new Map<string, string>(),
              inlineTexts: new Map<string, string>(),
            }
          : await prepareInlineAttachments(sessionId, prepared, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = settings.sendLatestReminder
          ? prepared.prefix
            ? prepared.prefix.latestReminder
            : createLatestReminder(settings)
          : undefined
        reply = { ...reply, ...(latestReminder ? { latestReminder } : {}) }
        updateReply(sessionId, reply)
        persist(sessionId)
        const baseSystem = settings.systemPrompt.trim()
        const replyModeInstruction = getReplyModeInstruction(settings.replyMode)
        const voiceSystem = request.voiceCall ? settings.voiceSystemPrompt.trim() : ''
        const visionHint =
          request.voiceCall && prepared.question.files.some((file) => file.isImage)
            ? '当前为实时视频通话，用户消息附带的图片是此刻摄像头实时画面，请像面对面看画面一样直接自然回应。'
            : ''
        const canModelGenerateImage =
          settings.imageGenChannel.enabled && Boolean(settings.imageGenChannel.model.trim())
        const imageGenHint = canModelGenerateImage
          ? '你已接入生图模型，具备直接为用户生成图片与图生图（基于用户上传的参考图片修改或重绘）的能力。当用户要求画画、生成图片、设计配图、修改图片或图生图时，绝对不要说“我无法生成图片”，而是在回复末尾输出一行标记：<generate_image>详细的英文或中文绘画/改图提示词</generate_image>。客户端会自动提取该提示词（若有本轮上传图片也会一并作为参考图）调用生图模型展示给用户。如果用户只是普通聊天或询问图片内容而非要求画图/改图，不要输出该标记。'
          : ''
        // 续写不重新注入动态变化的长期记忆/跨对话记忆，保持本轮上下文稳定与前缀缓存命中。
        const savedMemoryContext =
          !prepared.prefix && settings.savedMemoryEnabled ? formatSavedMemories() : ''
        const memoryContext =
          !prepared.prefix && settings.crossChatMemory
            ? await buildCrossChatMemory({
                currentSessionId: sessionId,
                query: inlinePrepared.question.content,
                sessions: get().sessions,
                sessionCache: get().sessionCache,
                maxSessions: settings.crossChatMemoryLimit,
                allowRefused: settings.allowRefusedContext,
                scope: settings.crossChatMemoryScope,
                selectedSessionIds: settings.crossChatMemorySessionIds,
                signal: controller.signal,
              })
            : ''
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now(), undefined, settings.keepRefusedContent)
          break
        }
        // 缓存铁律：system 和已保存的历史轮次必须逐字节稳定，绝不因模式或记忆变更导致整段前缀缓存失效。
        // 回复模式、语音模式与实时画面指令前置；长期记忆与跨对话召回作为尾注背景档案，
        // 既避免模型把长期记忆误判为“本轮用户刚下发的新任务”，又保证 system 与全部历史轮次命中前缀缓存。
        const turnDirectives = [
          replyModeInstruction ? `<reply_mode>\n${replyModeInstruction}\n</reply_mode>` : '',
          voiceSystem ? `<voice_call_mode>\n${voiceSystem}\n</voice_call_mode>` : '',
          visionHint ? `<live_vision_hint>\n${visionHint}\n</live_vision_hint>` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        const turnNotes = [
          savedMemoryContext
            ? `<long_term_memory>\n${savedMemoryContext}\n</long_term_memory>`
            : '',
          memoryContext ? `<cross_chat_memory>\n${memoryContext}\n</cross_chat_memory>` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        const combinedContent = [turnDirectives, inlinePrepared.question.content, turnNotes]
          .filter(Boolean)
          .join('\n\n')
        const outboundQuestion =
          turnDirectives || turnNotes
            ? {
                ...inlinePrepared.question,
                content: combinedContent,
              }
            : inlinePrepared.question
        const builtRequest = toRequestMessagesWithSources(
          prepared.history,
          outboundQuestion,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          settings.allowRefusedContext,
          settings.chatProtocol !== 'deepseek',
          {
            skipFileIds: skippedHistoryFileIds,
            skipRoundUserIds,
            stripReadLinkAssistantIds,
            dropLeadingRounds,
          }
        )
        const messages = builtRequest.messages
        const system = [baseSystem, imageGenHint].filter(Boolean).join('\n\n')
        builtSourceEntries = alignSourceEntriesForProtocol(
          messages,
          builtRequest.sourceEntries,
          system,
          settings.chatProtocol
        )
        builtRoundCount = builtRequest.roundCount
        const hasDocumentBlocks =
          settings.chatProtocol === 'deepseek' &&
          messages.some(
            (message) =>
              typeof message.content !== 'string' &&
              message.content.some((block) => block.type === 'document')
          )
        // DeepSeek 扩展模式不支持 document 内容块；有文档时改用标准模式，优先保证文件可被识别。
        const tools = hasDocumentBlocks
          ? undefined
          : serverTools(initial.search ?? false, settings.readUrl)
        const requestBody: CreateMessageRequest = {
          model: initial.model ?? (settings.model.trim() || MODEL),
          ...(system ? { system } : {}),
          messages,
          thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
          ...(settings.safetyCheck && !hasDocumentBlocks ? { safety_check: SAFETY_CHECK } : {}),
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(settings.temperature !== null ? { temperature: settings.temperature } : {}),
          ...(settings.topP !== null ? { top_p: settings.topP } : {}),
          ...(settings.maxTokens !== null ? { max_tokens: settings.maxTokens } : {}),
          ...(settings.autoTitle && titleRequests.has(controller)
            ? { title: { enabled: true } }
            : {}),
        }
        const events =
          settings.chatProtocol === 'responses'
            ? streamResponsesMessage(
                settings.apiOrigin || getApiOrigin(),
                settings.apiKey ?? '',
                requestBody,
                controller.signal,
                inlinePrepared.inlineImages,
                inlinePrepared.inlineTexts,
                settings.customHeaders,
                settings.thinkingEffort
              )
            : settings.chatProtocol === 'openai' || settings.chatProtocol === 'local'
              ? streamOpenAIMessage(
                  settings.apiOrigin || getApiOrigin(),
                  settings.apiKey ?? '',
                  requestBody,
                  controller.signal,
                  inlinePrepared.inlineImages,
                  inlinePrepared.inlineTexts,
                  settings.customHeaders,
                  settings.thinkingEffort
                )
              : streamMessage(settings.apiKey ?? '', requestBody, controller.signal)
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (event.type === 'message_start' && event.message.usage) {
            turnUsage = event.message.usage
          } else if (event.type === 'message_delta' && event.usage) {
            turnUsage = event.usage
          }
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now(), undefined, settings.keepRefusedContent)

        // 若模型在回复中输出了 <generate_image>...</generate_image>，按确认开关决定先确认或立即生图
        if (canModelGenerateImage && reply.stopReason !== 'refusal') {
          const match = IMAGE_GEN_TAG_RE.exec(getReplyText(reply))
          const imgPrompt = match?.[1]?.trim()
          if (imgPrompt) {
            const sourceFileIds = prepared.question.files
              .filter((file) => file.isImage)
              .map((file) => file.id)
            reply = {
              ...reply,
              blocks: reply.blocks.map((block) =>
                block.type === 'text'
                  ? {
                      ...block,
                      text: block.text
                        .replace(IMAGE_GEN_TAG_RE_G, '')
                        .replace(/<\/?generate_image>/gi, '')
                        .trim(),
                    }
                  : block
              ),
            }
            const initialSize =
              sourceFileIds.length > 0 ? 'match' : settings.imageGenChannel.size || 'auto'
            if (settings.imageGenChannel.requireConfirm) {
              reply = {
                ...reply,
                blocks: [
                  ...reply.blocks,
                  {
                    type: 'image',
                    fileId: '',
                    mimeType: 'image/png',
                    prompt: imgPrompt,
                    size: initialSize,
                    ...(sourceFileIds.length > 0 ? { sourceFileIds } : {}),
                    status: 'pending_confirm',
                  },
                ],
              }
            } else {
              updateReply(sessionId, reply)
              try {
                const generated = await saveAndCreateImageBlock(
                  imgPrompt,
                  controller.signal,
                  sessionId,
                  sourceFileIds,
                  initialSize
                )
                reply = {
                  ...reply,
                  blocks: [
                    ...reply.blocks,
                    {
                      type: 'image',
                      fileId: generated.fileId,
                      mimeType: generated.mimeType,
                      prompt: imgPrompt,
                      size: generated.resolvedSize ?? initialSize,
                      ...(sourceFileIds.length > 0 ? { sourceFileIds } : {}),
                      status: 'done',
                    },
                  ],
                }
              } catch (imgError) {
                if (!controller.signal.aborted) {
                  const errText = imgError instanceof Error ? imgError.message : String(imgError)
                  reply = {
                    ...reply,
                    blocks: [...reply.blocks, { type: 'text', text: `\n\n[生图失败：${errText}]` }],
                  }
                }
              }
            }
          }
        }

        if (
          settings.autoExtractMemory &&
          settings.savedMemoryEnabled &&
          reply.stopReason !== 'refusal' &&
          inlinePrepared.question.content.trim()
        ) {
          void extractMemoriesFromTurn({
            apiKey: settings.apiKey ?? '',
            model: initial.model ?? (settings.model.trim() || MODEL),
            protocol: settings.chatProtocol,
            baseUrl: settings.apiOrigin,
            customHeaders: settings.customHeaders,
            userText: inlinePrepared.question.content,
            assistantText: getReplyText(reply),
          })
        }
        if (
          useSettings.getState().autoPlayVoice &&
          !controller.signal.aborted &&
          reply.stopReason !== 'refusal' &&
          get().activeId === sessionId
        ) {
          const spokenText = getReplyText(reply).trim()
          if (spokenText) {
            toggleReadAloud(reply.id, spokenText, () => {})
          }
        }
        break
      } catch (error) {
        const { keepRefusedContent } = useSettings.getState()
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now(), undefined, keepRefusedContent)
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          fileRetryAttempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(fileRetryAttempt, controller.signal)
          fileRetryAttempt += 1
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now(), undefined, keepRefusedContent)
            break
          }
          continue
        }
        // 老对话/导入历史消息自愈：自动跳过服务端拒绝的历史破损图片、失效工具块或超长头部轮次后重发。
        if (!preparing && !receivedContent && healAttempts < MAX_HISTORY_HEAL_ATTEMPTS) {
          const loc = error instanceof ApiError ? parseMessageErrorLocation(error.message) : null
          const source = loc ? builtSourceEntries[loc.messageIndex] : undefined
          if (source?.kind === 'historyUser') {
            const mentioned = error instanceof ApiError ? extractFileIds(error.message) : []
            const indexedFile =
              typeof loc?.blockIndex === 'number' ? source.sentFiles[loc.blockIndex] : undefined
            const badIds = [
              ...(indexedFile
                ? [indexedFile.id, ...(indexedFile.serverId ? [indexedFile.serverId] : [])]
                : []),
              ...mentioned,
            ]
            if (badIds.length > 0) {
              badIds.forEach((id) => skippedHistoryFileIds.add(id))
              markSkippedHistoryFileIds(badIds)
            } else if (
              source.sentFiles.length > 0 &&
              /image|file|content|format/i.test(String(error))
            ) {
              const allFileIds = source.sentFiles.flatMap((file) => [
                file.id,
                ...(file.serverId ? [file.serverId] : []),
              ])
              allFileIds.forEach((id) => skippedHistoryFileIds.add(id))
              markSkippedHistoryFileIds(allFileIds)
            } else {
              skipRoundUserIds.add(source.userMessageId)
            }
            healAttempts += 1
            continue
          }
          if (source?.kind === 'historyAssistant') {
            if (!stripReadLinkAssistantIds.has(source.assistantMessageId)) {
              stripReadLinkAssistantIds.add(source.assistantMessageId)
            } else {
              skipRoundUserIds.add(source.userMessageId)
            }
            healAttempts += 1
            continue
          }
          if (isTooManyImagesError(error)) {
            const oldestImageIds = builtSourceEntries
              .flatMap((entry) =>
                entry.kind === 'historyUser'
                  ? entry.sentFiles.filter((file) => file.isImage).map((file) => file.id)
                  : []
              )
              .filter((id) => !skippedHistoryFileIds.has(id))
              .slice(0, 8)
            if (oldestImageIds.length > 0) {
              oldestImageIds.forEach((id) => skippedHistoryFileIds.add(id))
              healAttempts += 1
              continue
            }
          }
          if (isContextOverflowError(error) && builtRoundCount > 1) {
            dropLeadingRounds += Math.max(1, Math.ceil(builtRoundCount * 0.35))
            healAttempts += 1
            continue
          }
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now(), undefined, keepRefusedContent)
        } else if (error instanceof ApiError) {
          reply = settleReply(
            reply,
            'error',
            Date.now(),
            {
              kind: error.kind,
              message: error.message,
              status: error.status,
              localMessage: error.localMessage,
            },
            keepRefusedContent
          )
        } else {
          reply = settleReply(
            reply,
            'error',
            Date.now(),
            {
              kind: 'protocol',
              message: error instanceof Error ? error.message : String(error),
            },
            keepRefusedContent
          )
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    if (turnUsage) {
      recordTurnTokenUsage(turnUsage)
    }
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
