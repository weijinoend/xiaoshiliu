import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
} from '../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 当使用本地内联模式（如 OpenAI 兼容或自定义识别）时，可用本地 id 占位供上层替换。
 */
const toFileBlocks = (files: FileAttachment[], useLocalId = false): FileBlockParam[] =>
  files.flatMap(({ id, serverId, isImage }) => {
    const refId = useLocalId ? (serverId ?? id) : serverId
    return refId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: refId },
          },
        ]
      : []
  })

const filterSkippedFiles = (files: FileAttachment[], skipFileIds?: ReadonlySet<string>) =>
  skipFileIds && skipFileIds.size > 0
    ? files.filter(
        (file) => !skipFileIds.has(file.id) && !(file.serverId && skipFileIds.has(file.serverId))
      )
    : files

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        // 客户端工具内容不保存；未完成的工具往返也不能作为续写前缀。
        return event.content_block.type === 'tool_use' ? { ...next, prefix: false } : next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) =>
        block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      )
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时默认按协议丢弃思考与正文（仅保留工具块）；
 * 若 keepRefusedContent 为 true，则保留已下发内容。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error'],
  keepRefusedContent = false
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (
      !keepRefusedContent &&
      reply.stopReason === 'refusal' &&
      (block.type === 'thinking' || block.type === 'text')
    ) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 默认拒绝与服务端模板提示不能续写；当 allowRefused 为 true 时允许被拒回复继续生成。
 */
export const canContinueReply = (reply: AssistantMessage, allowRefused = false): boolean => {
  if (
    !reply.prefix ||
    (!allowRefused && reply.stopReason === 'refusal') ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        (!allowRefused && block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' ||
    (reply.status === 'done' &&
      (reply.stopReason === 'max_tokens' || (allowRefused && reply.stopReason === 'refusal')))
  )
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；默认被安全拒绝或模板提示不回传。
 * 当 allowRefused 为 true 时，允许含文本内容的被拒轮次进入上下文。
 */
const isUsableReply = (message: Message, allowRefused = false): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  (allowRefused ||
    (message.stopReason !== 'refusal' &&
      !message.blocks.some((block) => block.type === 'text' && block.isTemplate))) &&
  (getReplyText(message) !== '' ||
    message.blocks.some((block) => block.type === 'image' && block.fileId !== ''))

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = (
  { content, files }: UserMessage,
  useLocalId = false,
  skipFileIds?: ReadonlySet<string>
): { param: MessageParam; sentFiles: FileAttachment[] } => {
  const activeFiles = filterSkippedFiles(files, skipFileIds)
  const blocks = toFileBlocks(activeFiles, useLocalId)
  const hadSkippedAllFiles =
    activeFiles.length === 0 &&
    files.length > 0 &&
    blocks.length === 0 &&
    skipFileIds &&
    skipFileIds.size > 0 &&
    files.some((f) => skipFileIds.has(f.id) || (f.serverId && skipFileIds.has(f.serverId)))
  if (blocks.length === 0) {
    return {
      param: {
        role: 'user',
        content: content || (hadSkippedAllFiles ? '[历史附件无法识别，已自动忽略]' : ''),
      },
      sentFiles: [],
    }
  }
  const sentFiles = activeFiles.filter((file) =>
    useLocalId ? (file.serverId ?? file.id) : file.serverId
  )
  return {
    param: {
      role: 'user',
      content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
    },
    sentFiles,
  }
}

/**
 * assistant 的内容块按历史与续写场景转换：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾；
 */
const toAssistantParam = (
  { blocks }: AssistantMessage,
  prefix = false,
  thinking = false,
  stripReadLink = false
): Extract<MessageParam, { role: 'assistant' }> => {
  const content: AssistantBlockParam[] = []
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  for (const block of blocks) {
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    if (block.type === 'image') {
      if (!block.fileId) {
        continue
      }
      const note = `[已生成图片${block.prompt ? `：${block.prompt}` : ''}]`
      if (text) {
        text.text += `\n${note}`
      } else {
        text = { type: 'text', text: note }
        content.push(text)
      }
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      // 续写保留本轮思考，历史轮次的思考省略。
      const { type, thinking, signature } = block
      content.push({ type, thinking, signature: signature ?? '' })
    } else if (
      !stripReadLink &&
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      !stripReadLink &&
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    }
  }
  const filtered = content.filter((block) => block.type !== 'text' || block.text !== '')
  return {
    role: 'assistant',
    content: filtered.length > 0 || !stripReadLink ? filtered : [{ type: 'text', text: '...' }],
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (
  history: Message[],
  allowRefused = false
): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply, allowRefused)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

export type RequestBuildOptions = {
  skipFileIds?: ReadonlySet<string>
  skipRoundUserIds?: ReadonlySet<string>
  stripReadLinkAssistantIds?: ReadonlySet<string>
  dropLeadingRounds?: number
}

export type RequestMessageSource =
  | { kind: 'reminder' }
  | { kind: 'historyUser'; userMessageId: string; sentFiles: FileAttachment[] }
  | { kind: 'historyAssistant'; userMessageId: string; assistantMessageId: string }
  | { kind: 'currentQuestion' }
  | { kind: 'prefix' }

export const toRequestMessagesWithSources = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  allowRefused = false,
  useLocalFileId = false,
  options?: RequestBuildOptions
): {
  messages: MessageParam[]
  sourceEntries: RequestMessageSource[]
  roundCount: number
} => {
  const messages: MessageParam[] = []
  const sourceEntries: RequestMessageSource[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      sourceEntries.push({ kind: 'reminder' })
      previousReminder = reminder
    }
  }
  const allRounds = getContextRounds(history, allowRefused).slice(
    Math.max(0, options?.dropLeadingRounds ?? 0)
  )
  let roundCount = 0
  for (const [user, reply] of allRounds) {
    if (options?.skipRoundUserIds?.has(user.id)) {
      continue
    }
    const builtUser = toUserParam(user, useLocalFileId, options?.skipFileIds)
    // 历史提问没有文字也没有可用内容块时，连同回答一起省略。
    if (!builtUser.param.content) {
      continue
    }
    const assistantParam = toAssistantParam(
      reply,
      false,
      false,
      options?.stripReadLinkAssistantIds?.has(reply.id) ?? false
    )
    if (assistantParam.content.length === 0) {
      continue
    }
    appendReminder(reply.latestReminder)
    messages.push(builtUser.param, assistantParam)
    sourceEntries.push(
      { kind: 'historyUser', userMessageId: user.id, sentFiles: builtUser.sentFiles },
      { kind: 'historyAssistant', userMessageId: user.id, assistantMessageId: reply.id }
    )
    roundCount += 1
  }
  appendReminder(latestReminder)
  messages.push(toUserParam(question, useLocalFileId).param)
  sourceEntries.push({ kind: 'currentQuestion' })
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
      sourceEntries.push({ kind: 'prefix' })
    }
  }
  return { messages, sourceEntries, roundCount }
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  allowRefused = false,
  useLocalFileId = false
): MessageParam[] =>
  toRequestMessagesWithSources(
    history,
    question,
    prefix,
    thinking,
    latestReminder,
    allowRefused,
    useLocalFileId
  ).messages

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
