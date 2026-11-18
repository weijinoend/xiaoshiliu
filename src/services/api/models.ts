import {
  fetchWithDevProxy,
  getApiOrigin,
  joinApiPath,
  normalizeOrigin,
  parseCustomHeaders,
} from './origin.js'

const parseModelIds = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null) {
    return []
  }
  const record = body as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      ids.push(item.trim())
    } else if (typeof item === 'object' && item !== null) {
      const entry = item as Record<string, unknown>
      const id =
        typeof entry.id === 'string'
          ? entry.id
          : typeof entry.name === 'string'
            ? entry.name.replace(/^models\//, '')
            : ''
      if (id.trim()) {
        ids.push(id.trim())
      }
    }
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * 从兼容服务的 /models 或 /v1/models 动态拉取可用模型列表。
 * 依次尝试 {base}/models 与 {base}/v1/models（避免重复 /v1）。
 */
export const fetchAvailableModels = async (
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  customHeadersRaw = ''
): Promise<string[]> => {
  const origin = normalizeOrigin(baseUrl) || getApiOrigin()
  const rootOrigin = origin.replace(/\/v\d+(?:beta)?(?:\/openai)?$/i, '')
  const candidates = [
    ...new Set([joinApiPath(origin, '/models'), `${origin}/models`, `${rootOrigin}/api/tags`]),
  ]
  const headers: Record<string, string> = {
    ...parseCustomHeaders(customHeadersRaw),
  }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      const response = await fetchWithDevProxy(url, { method: 'GET', headers, signal })
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText)
        let message = text || `HTTP ${response.status}`
        try {
          const errJson: unknown = JSON.parse(text)
          if (
            typeof errJson === 'object' &&
            errJson !== null &&
            typeof (errJson as { error?: { message?: unknown } }).error?.message === 'string'
          ) {
            message = (errJson as { error: { message: string } }).error.message
          }
        } catch {
          // 保留原文
        }
        lastError = new Error(message)
        continue
      }
      const json: unknown = await response.json()
      const ids = parseModelIds(json)
      if (ids.length > 0) {
        return ids
      }
      lastError = new Error('Empty model list')
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError ?? new Error('Failed to fetch models')
}
