/** 移动端硬件/手势返回键栈：按注册优先级消费返回事件，避免直接退出应用 */
type BackEntry = {
  priority: number
  handle: () => boolean
}

const entries = new Set<BackEntry>()

export const registerAndroidBackHandler = (priority: number, handle: () => boolean) => {
  const entry: BackEntry = { priority, handle }
  entries.add(entry)
  return () => {
    entries.delete(entry)
  }
}

export const dispatchAndroidBack = (): boolean => {
  const ordered = [...entries].sort((a, b) => b.priority - a.priority)
  for (const entry of ordered) {
    if (entry.handle()) {
      return true
    }
  }
  return false
}

export const installAndroidBackBridge = () => {
  if (typeof window === 'undefined') {
    return
  }
  ;(window as { __deepjeekHandleAndroidBack?: () => boolean }).__deepjeekHandleAndroidBack =
    dispatchAndroidBack
}
