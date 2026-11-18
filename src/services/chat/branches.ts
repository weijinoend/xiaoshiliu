import type { Message, Session } from './types.js'

/** 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。 */
export const normalizeSession = (session: Session): Session =>
  session.rootMessageId !== undefined
    ? session
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

/** 一次遍历收集兄弟版本；版本列表未变化时复用旧对象与索引，避免流式正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>
): ReadonlyMap<string, MessageVersions> => {
  const groups = new Map<string | null | undefined, string[]>()
  for (const message of session.messages) {
    const key = session.rootMessageId === undefined ? message.id : message.parentId
    const ids = groups.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      groups.set(key, [message.id])
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === session.messages.length
  for (const ids of groups.values()) {
    const cachedIds = previous.get(ids[0])?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    ids.forEach((id, index) => {
      const cached = previous.get(id)
      const version =
        cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
      versions.set(id, version)
      if (version !== cached) {
        unchanged = false
      }
    })
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  return {
    ...session,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  return {
    ...session,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}

/** 删除指定消息及其向下衍生的整棵分支子树；若有同父兄弟版本则切换到相邻版本，否则上层节点截止于此。 */
export const deleteBranchFrom = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const target = session.messages.find((item) => item.id === messageId)
  if (!target) {
    return original
  }

  const removed = new Set<string>([messageId])
  let added = true
  while (added) {
    added = false
    for (const item of session.messages) {
      if (!removed.has(item.id) && item.parentId && removed.has(item.parentId)) {
        removed.add(item.id)
        added = true
      }
    }
  }

  const parentId = target.parentId ?? null
  const siblings = session.messages.filter((item) => (item.parentId ?? null) === parentId)
  const targetIndex = siblings.findIndex((item) => item.id === messageId)
  const nextSibling = siblings[targetIndex - 1] ?? siblings[targetIndex + 1] ?? undefined

  const remaining = session.messages
    .filter((item) => !removed.has(item.id))
    .map((item) => {
      if (parentId !== null && item.id === parentId && item.selectedChildId === messageId) {
        return { ...item, selectedChildId: nextSibling?.id }
      }
      return item
    })

  const rootMessageId =
    parentId === null
      ? session.rootMessageId === messageId
        ? (nextSibling?.id ?? null)
        : (session.rootMessageId ?? null)
      : (session.rootMessageId ?? null)

  return {
    ...session,
    rootMessageId,
    messages: remaining,
  }
}

/** 收集从根节点到目标消息为止的直线上下文，并重建为干净的单分支消息列表。 */
export const forkPathMessages = (
  original: Session,
  messageId: string,
  createNewId: () => string
): Message[] => {
  const session = normalizeSession(original)
  const byId = new Map(session.messages.map((item) => [item.id, item]))
  const reversed: Message[] = []
  const visited = new Set<string>()
  let cursor: string | null | undefined = messageId
  while (cursor) {
    if (visited.has(cursor)) {
      break
    }
    visited.add(cursor)
    const item = byId.get(cursor)
    if (!item) {
      break
    }
    reversed.push(item)
    cursor = item.parentId ?? null
  }
  const chain = reversed.reverse()
  if (chain.length === 0) {
    return []
  }
  const newIds = chain.map(() => createNewId())
  return chain.map((item, index) => ({
    ...item,
    id: newIds[index],
    parentId: index === 0 ? null : newIds[index - 1],
    selectedChildId: index < chain.length - 1 ? newIds[index + 1] : undefined,
  }))
}

/** 将会话的分支路径调整为包含目标消息（若目标处于非当前分支中，逐级切换父节点选中子项）。 */
export const revealMessageBranch = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const byId = new Map(session.messages.map((item) => [item.id, item]))
  if (!byId.has(messageId)) {
    return original
  }
  const updates = new Map<string, string>()
  let rootMessageId = session.rootMessageId ?? null
  let childId: string | null = messageId
  const visited = new Set<string>()
  while (childId && !visited.has(childId)) {
    visited.add(childId)
    const child = byId.get(childId)
    if (!child) {
      break
    }
    const parentId = child.parentId ?? null
    if (parentId === null) {
      rootMessageId = child.id
      break
    }
    updates.set(parentId, child.id)
    childId = parentId
  }
  let changed = rootMessageId !== (session.rootMessageId ?? null)
  const messages = session.messages.map((item) => {
    const nextChild = updates.get(item.id)
    if (nextChild && item.selectedChildId !== nextChild) {
      changed = true
      return { ...item, selectedChildId: nextChild }
    }
    return item
  })
  return changed ? { ...session, rootMessageId, messages } : original
}
