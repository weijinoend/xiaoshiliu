/** 构建期默认 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__

let runtimeApiOrigin = ''

export const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, '')

export const setRuntimeApiOrigin = (origin: string) => {
  runtimeApiOrigin = normalizeOrigin(origin)
}

export const getApiOrigin = (): string => runtimeApiOrigin || API_ORIGIN

/**
 * 拼接 OpenAI 兼容接口路径：
 * 若用户填写的 Base URL 已包含 /v1（或 /v1beta/openai 等版本后缀），则不再重复拼接 /v1。
 */
export const joinApiPath = (baseUrl: string, v1Subpath: string): string => {
  const base = normalizeOrigin(baseUrl) || getApiOrigin()
  const sub = v1Subpath.startsWith('/') ? v1Subpath : `/${v1Subpath}`
  if (/\/v\d+(?:beta)?(?:\/openai)?$/i.test(base)) {
    return `${base}${sub}`
  }
  return `${base}/v1${sub}`
}

/**
 * 解析自定义请求头配置：支持 JSON 对象（如 {"x-foo":"bar"}）或每行一个 Key: Value / Key = Value。
 */
export const parseCustomHeaders = (raw: string): Record<string, string> => {
  const text = raw.trim()
  if (!text) {
    return {}
  }
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const result: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (
            k.trim() &&
            (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          ) {
            result[k.trim()] = String(v)
          }
        }
        return result
      }
    } catch {
      // 解析 JSON 失败时继续尝试按行解析
    }
  }
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/.exec(line)
    if (match) {
      const key = match[1].replace(/^["']|["']$/g, '').trim()
      const value = match[2]
        .replace(/^["']|["']$/g, '')
        .replace(/,\s*$/, '')
        .trim()
      if (key && value) {
        result[key] = value
      }
    }
  }
  return result
}

export const sanitizeWebUrl = (url: string | null | undefined): string | undefined => {
  if (!url) {
    return undefined
  }
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

export const getAndroidProxyOrigin = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = (window as { __DEEPJEEK_ANDROID_BRIDGE__?: { getProxyOrigin?: () => string } })
    .__DEEPJEEK_ANDROID_BRIDGE__
  const origin = bridge?.getProxyOrigin?.()
  return origin && /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin) ? origin : null
}

export const getAndroidProxyToken = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = (window as { __DEEPJEEK_ANDROID_BRIDGE__?: { getProxyToken?: () => string } })
    .__DEEPJEEK_ANDROID_BRIDGE__
  const token = bridge?.getProxyToken?.()
  return token && token.trim() ? token.trim() : null
}

const shouldTryLocalProxy = (): boolean => {
  if (__DEV_PROXY__ || getAndroidProxyOrigin()) {
    return true
  }
  if (typeof window === 'undefined') {
    return false
  }
  const { protocol, hostname } = window.location
  return (
    (protocol === 'http:' || protocol === 'https:') &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
  )
}

/**
 * 发起 fetch 请求；在本地开发、本地部署或 Android APK 下若遇到跨域拦截（TypeError），自动通过本地代理转发。
 */
export const fetchWithDevProxy = async (url: string, init: RequestInit = {}): Promise<Response> => {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted || !shouldTryLocalProxy() || !/^https?:\/\//i.test(url)) {
      throw error
    }
    const headers = new Headers(init.headers)
    headers.set('x-proxy-target', url)
    const androidProxyOrigin = getAndroidProxyOrigin()
    const proxyToken = getAndroidProxyToken()
    if (androidProxyOrigin && proxyToken) {
      headers.set('X-Proxy-Token', proxyToken)
    }
    const proxyEndpoint = androidProxyOrigin
      ? `${androidProxyOrigin}/__api_proxy__`
      : '/__api_proxy__'
    const proxied = await fetch(proxyEndpoint, {
      ...init,
      headers,
    })
    if (proxied.status === 404 && !proxied.headers.has('x-local-proxy')) {
      throw error
    }
    return proxied
  }
}
