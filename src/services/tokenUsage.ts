import { create } from 'zustand'
import type { MessageUsage } from './api/types.js'
import { useSettings } from './settings.js'

const DAILY_USAGE_KEY = 'chat-demo:daily-token-usage'

export type DailyTokenStats = {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  alertedDate: string | null
}

type DailyTokenStore = DailyTokenStats & {
  limitModalOpen: boolean
}

const getTodayKey = (date = new Date()): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const emptyStats = (date = getTodayKey()): DailyTokenStats => ({
  date,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  alertedDate: null,
})

const readStoredStats = (): DailyTokenStats => {
  const today = getTodayKey()
  try {
    const raw = localStorage.getItem(DAILY_USAGE_KEY)
    if (!raw) {
      return emptyStats(today)
    }
    const parsed = JSON.parse(raw) as Partial<DailyTokenStats>
    if (parsed.date !== today) {
      return emptyStats(today)
    }
    const input =
      typeof parsed.inputTokens === 'number' && parsed.inputTokens >= 0 ? parsed.inputTokens : 0
    const output =
      typeof parsed.outputTokens === 'number' && parsed.outputTokens >= 0 ? parsed.outputTokens : 0
    return {
      date: today,
      inputTokens: input,
      outputTokens: output,
      totalTokens:
        typeof parsed.totalTokens === 'number' && parsed.totalTokens >= 0
          ? parsed.totalTokens
          : input + output,
      alertedDate: typeof parsed.alertedDate === 'string' ? parsed.alertedDate : null,
    }
  } catch {
    return emptyStats(today)
  }
}

const writeStoredStats = (stats: DailyTokenStats) => {
  try {
    localStorage.setItem(DAILY_USAGE_KEY, JSON.stringify(stats))
  } catch {
    // 忽略本地存储空间不足等错误
  }
}

export const useDailyTokenUsage = create<DailyTokenStore>(() => ({
  ...readStoredStats(),
  limitModalOpen: false,
}))

/** 同步检查当前日期，如果跨天则自动归零今日计数 */
export const syncDailyTokenDate = () => {
  const today = getTodayKey()
  const current = useDailyTokenUsage.getState()
  if (current.date !== today) {
    const fresh = emptyStats(today)
    writeStoredStats(fresh)
    useDailyTokenUsage.setState({ ...fresh, limitModalOpen: false })
  }
}

/** 记录单次回复的 Token 消耗；达到用户设定的每日上限时触发一次弹窗提醒 */
export const recordTurnTokenUsage = (usage: MessageUsage) => {
  const input =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  const output = usage.output_tokens
  const addedTotal = input + output
  if (addedTotal <= 0) {
    return
  }

  const today = getTodayKey()
  const prev = useDailyTokenUsage.getState()
  const base = prev.date === today ? prev : emptyStats(today)
  const nextInput = base.inputTokens + input
  const nextOutput = base.outputTokens + output
  const nextTotal = base.totalTokens + addedTotal

  const { tokenLimitEnabled, dailyTokenLimit } = useSettings.getState()
  const shouldAlert =
    tokenLimitEnabled &&
    dailyTokenLimit > 0 &&
    nextTotal >= dailyTokenLimit &&
    base.alertedDate !== today

  const nextStats: DailyTokenStats = {
    date: today,
    inputTokens: nextInput,
    outputTokens: nextOutput,
    totalTokens: nextTotal,
    alertedDate: shouldAlert ? today : base.alertedDate,
  }
  writeStoredStats(nextStats)
  useDailyTokenUsage.setState({
    ...nextStats,
    limitModalOpen: shouldAlert ? true : prev.limitModalOpen,
  })
}

export const dismissTokenLimitModal = () => {
  useDailyTokenUsage.setState({ limitModalOpen: false })
}

export const resetDailyTokenUsage = () => {
  const fresh = emptyStats(getTodayKey())
  writeStoredStats(fresh)
  useDailyTokenUsage.setState({ ...fresh, limitModalOpen: false })
}
