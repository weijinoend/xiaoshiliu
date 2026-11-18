import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { streamMessage } from '../api/client.js'
import { streamOpenAIMessage, streamResponsesMessage } from '../api/openai.js'
import { getApiOrigin } from '../api/origin.js'

export type SavedMemoryItem = {
  id: string
  content: string
  enabled: boolean
  updatedAt: number
}

const STORAGE_KEY = 'chat-demo:saved-memories'
const MAX_SAVED_MEMORY_CHARS = 1800

type MemoryNoticeListener = (summary: string) => void
const memoryListeners = new Set<MemoryNoticeListener>()

export const onMemoryUpdated = (listener: MemoryNoticeListener) => {
  memoryListeners.add(listener)
  return () => {
    memoryListeners.delete(listener)
  }
}

const readSavedMemories = (): SavedMemoryItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is SavedMemoryItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SavedMemoryItem).id === 'string' &&
        typeof (item as SavedMemoryItem).content === 'string' &&
        typeof (item as SavedMemoryItem).enabled === 'boolean' &&
        typeof (item as SavedMemoryItem).updatedAt === 'number'
    )
  } catch {
    return []
  }
}

const writeSavedMemories = (items: SavedMemoryItem[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 存储不可用时仅保留在内存中
  }
}

export const useSavedMemories = create<{ items: SavedMemoryItem[] }>(() => ({
  items: readSavedMemories(),
}))

const commit = (items: SavedMemoryItem[]) => {
  writeSavedMemories(items)
  useSavedMemories.setState({ items })
}

export const addSavedMemory = (content: string): SavedMemoryItem | null => {
  const text = content.trim()
  if (!text) {
    return null
  }
  const current = useSavedMemories.getState().items
  const duplicate = current.find((item) => item.content.trim().toLowerCase() === text.toLowerCase())
  if (duplicate) {
    if (!duplicate.enabled) {
      commit(
        current.map((item) =>
          item.id === duplicate.id ? { ...item, enabled: true, updatedAt: Date.now() } : item
        )
      )
    }
    return duplicate
  }
  const created: SavedMemoryItem = {
    id: createId(),
    content: text,
    enabled: true,
    updatedAt: Date.now(),
  }
  commit([created, ...current])
  return created
}

export const updateSavedMemory = (id: string, content: string): boolean => {
  const text = content.trim()
  if (!text) {
    return false
  }
  const current = useSavedMemories.getState().items
  if (!current.some((item) => item.id === id)) {
    return false
  }
  commit(
    current.map((item) =>
      item.id === id ? { ...item, content: text, updatedAt: Date.now() } : item
    )
  )
  return true
}

export const toggleSavedMemory = (id: string) => {
  const current = useSavedMemories.getState().items
  commit(
    current.map((item) =>
      item.id === id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item
    )
  )
}

export const deleteSavedMemory = (id: string) => {
  const current = useSavedMemories.getState().items
  commit(current.filter((item) => item.id !== id))
}

export const clearSavedMemories = () => {
  commit([])
}

/** 格式化已启用的长期记忆条目，注入请求 system */
export const formatSavedMemories = (): string => {
  const enabled = useSavedMemories
    .getState()
    .items.filter((item) => item.enabled && item.content.trim())
  if (enabled.length === 0) {
    return ''
  }
  const header =
    '以下是关于用户的长期记忆（已保存的个人事实、偏好与要求，请在回答时自然遵循和结合）：'
  const lines: string[] = [header]
  let total = header.length
  for (const item of enabled) {
    const line = `- ${item.content.trim()}`
    if (total + line.length + 1 > MAX_SAVED_MEMORY_CHARS && lines.length > 1) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

type MemoryOperation =
  | { action: 'add'; content: string }
  | { action: 'update'; id: string; content: string }
  | { action: 'delete'; id: string }

const EXTRACTOR_SYSTEM = `你是长期记忆提炼器。根据本轮对话，判断是否有需要长期保存的关于用户的稳定事实、身份、职业、长期偏好、常用工具/语言或明确要求“记住”的信息。
规则：
1. 只提取来自用户且具有长期价值的信息；一次性任务细节、临时报错代码或闲聊不要提取。
2. 如果新信息更新或推翻了已有记忆，使用 update 替换对应 id；如果用户要求忘记某条，使用 delete；如果是全新事实，使用 add。
3. 严禁重复添加已有记忆。如果没有任何需要新增或修改的记忆，必须返回 []。
4. 只输出合法 JSON 数组，不要输出任何额外解释或 Markdown。格式示例：
[{"action":"add","content":"用户是一名前端工程师，偏好使用 TypeScript"}]`

const parseOperations = (raw: string): MemoryOperation[] => {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!stripped.startsWith('[')) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (!Array.isArray(parsed)) {
      return []
    }
    const ops: MemoryOperation[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const record = item as Record<string, unknown>
      if (record.action === 'add' && typeof record.content === 'string' && record.content.trim()) {
        ops.push({ action: 'add', content: record.content.trim() })
      } else if (
        record.action === 'update' &&
        typeof record.id === 'string' &&
        typeof record.content === 'string' &&
        record.content.trim()
      ) {
        ops.push({ action: 'update', id: record.id, content: record.content.trim() })
      } else if (record.action === 'delete' && typeof record.id === 'string') {
        ops.push({ action: 'delete', id: record.id })
      }
    }
    return ops
  } catch {
    return []
  }
}

/** 对话完成后静默提炼长期记忆并更新本地列表 */
export const extractMemoriesFromTurn = async ({
  apiKey,
  model,
  protocol = 'deepseek',
  baseUrl = '',
  customHeaders = '',
  userText,
  assistantText,
  onUpdated,
}: {
  apiKey: string
  model: string
  protocol?: 'deepseek' | 'openai' | 'responses' | 'local'
  baseUrl?: string
  customHeaders?: string
  userText: string
  assistantText: string
  onUpdated?: (summary: string) => void
}): Promise<void> => {
  const question = userText.trim()
  if ((!apiKey && protocol === 'deepseek') || !question) {
    return
  }
  const existing = useSavedMemories.getState().items
  const existingBlock =
    existing.length > 0
      ? existing.map((item) => `[${item.id}] ${item.content}`).join('\n')
      : '（暂无）'

  const prompt = `已有记忆：\n${existingBlock}\n\n本轮对话：\n用户：${question}\n助手：${assistantText.slice(0, 600)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    let output = ''
    const reqBody = {
      model,
      system: EXTRACTOR_SYSTEM,
      messages: [{ role: 'user' as const, content: prompt }],
      thinking: { type: 'disabled' as const },
      temperature: 0,
      max_tokens: 300,
    }
    const events =
      protocol === 'responses'
        ? streamResponsesMessage(
            baseUrl || getApiOrigin(),
            apiKey,
            reqBody,
            controller.signal,
            new Map(),
            new Map(),
            customHeaders
          )
        : protocol === 'openai' || protocol === 'local'
          ? streamOpenAIMessage(
              baseUrl || getApiOrigin(),
              apiKey,
              reqBody,
              controller.signal,
              new Map(),
              new Map(),
              customHeaders
            )
          : streamMessage(apiKey, reqBody, controller.signal)
    for await (const event of events) {
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        output += event.content_block.text
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        output += event.delta.text
      }
    }
    const ops = parseOperations(output)
    if (ops.length === 0) {
      return
    }
    let changedText = ''
    for (const op of ops) {
      if (op.action === 'add') {
        const added = addSavedMemory(op.content)
        if (added) {
          changedText = added.content
        }
      } else if (op.action === 'update') {
        if (updateSavedMemory(op.id, op.content)) {
          changedText = op.content
        }
      } else if (op.action === 'delete') {
        deleteSavedMemory(op.id)
      }
    }
    if (changedText) {
      onUpdated?.(changedText)
      for (const listener of memoryListeners) {
        listener(changedText)
      }
    }
  } catch {
    // 后台记忆提炼失败时静默忽略，不影响正常对话
  } finally {
    clearTimeout(timer)
  }
}
