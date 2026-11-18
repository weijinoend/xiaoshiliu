import { getAndroidProxyOrigin } from '../services/api/origin.js'

export type DownloadDestination = 'android' | 'picker' | 'browser'

const triggerBrowserDownload = (blob: Blob, filename: string): DownloadDestination => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'browser'
}

/**
 * 将 Blob 保存到本地：
 * - Android APK 内通过本地原生代理写入系统「下载/小石榴」（Android 10+）或拉起系统保存选择器（Android 6~9）；
 * - 浏览器/桌面端通过标准 `<a download>` 触发下载。
 */
export const saveDownloadedBlob = async (
  blob: Blob,
  filename: string
): Promise<DownloadDestination> => {
  const androidProxy = getAndroidProxyOrigin()
  if (androidProxy) {
    const mime = blob.type || 'application/octet-stream'
    const endpoint = `${androidProxy}/__deepjeek_save_file?name=${encodeURIComponent(filename)}&mime=${encodeURIComponent(mime)}`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': mime,
      },
      body: blob,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail || `HTTP ${response.status}`)
    }
    const result = (await response.json().catch(() => null)) as { mode?: string } | null
    return result?.mode === 'picker' ? 'picker' : 'android'
  }
  return triggerBrowserDownload(blob, filename)
}

/** 从 blob:/data:/http: URL 读取内容并保存为本地文件。 */
export const saveDownloadedUrl = async (
  url: string,
  filename: string
): Promise<DownloadDestination> => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const blob = await response.blob()
  return saveDownloadedBlob(blob, filename)
}
