import { create } from 'zustand'
import { showToast } from '../components/base/toastState.js'
import { fetchWithDevProxy, sanitizeWebUrl } from './api/origin.js'

export const GITHUB_REPO = 'weijinoend/xiaoshiliu'
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const SKIPPED_VERSION_KEY = 'chat-demo:skipped-update-version'

export type ReleaseInfo = {
  version: string
  tagName: string
  title: string
  body: string
  publishedAt: string
  htmlUrl: string
  apkUrl: string | null
  apkName: string | null
  apkSize: number | null
}

export type AppVersionInfo = {
  isAndroid: boolean
  versionName: string
  versionCode: number | null
}

export type DownloadStatus = 'idle' | 'downloading' | 'installing' | 'permission_required' | 'error'

export type DownloadState = {
  status: DownloadStatus
  progress: number
  downloaded: number
  total: number
  error: string
  hasDownloadedFile: boolean
}

type AndroidUpdaterBridge = {
  getAppInfo?: () => string
  downloadAndInstallApk?: (apkUrl: string, fileName: string) => void
  getUpdateDownloadState?: () => string
  retryInstallDownloadedApk?: () => void
}

const getAndroidBridge = (): AndroidUpdaterBridge | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return (
    (window as { __DEEPJEEK_ANDROID_BRIDGE__?: AndroidUpdaterBridge })
      .__DEEPJEEK_ANDROID_BRIDGE__ ?? null
  )
}

export const getCurrentAppVersion = (): AppVersionInfo => {
  const bridge = getAndroidBridge()
  if (bridge?.getAppInfo) {
    try {
      const parsed = JSON.parse(bridge.getAppInfo()) as {
        isAndroid?: boolean
        versionName?: string
        versionCode?: number
      }
      if (parsed && typeof parsed.versionName === 'string' && parsed.versionName.trim()) {
        return {
          isAndroid: Boolean(parsed.isAndroid),
          versionName: parsed.versionName.trim(),
          versionCode: typeof parsed.versionCode === 'number' ? parsed.versionCode : null,
        }
      }
    } catch {
      // 解析原生版本信息失败时退回构建期版本
    }
  }
  return {
    isAndroid: false,
    versionName: __APP_VERSION__,
    versionCode: null,
  }
}

export const normalizeVersion = (raw: string): string => raw.trim().replace(/^v/i, '')

const parseVersionTuple = (raw: string): [number[], string] => {
  const clean = normalizeVersion(raw)
  const [core, pre = ''] = clean.split('-', 2)
  const nums = core.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  while (nums.length < 3) {
    nums.push(0)
  }
  return [nums, pre]
}

/** 比较版本号：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export const compareVersions = (a: string, b: string): number => {
  const [na, pa] = parseVersionTuple(a)
  const [nb, pb] = parseVersionTuple(b)
  const len = Math.max(na.length, nb.length)
  for (let i = 0; i < len; i++) {
    const va = na[i] ?? 0
    const vb = nb[i] ?? 0
    if (va > vb) {
      return 1
    }
    if (va < vb) {
      return -1
    }
  }
  if (!pa && pb) {
    return 1
  }
  if (pa && !pb) {
    return -1
  }
  return pa.localeCompare(pb)
}

const readSkippedVersion = (): string => {
  try {
    return localStorage.getItem(SKIPPED_VERSION_KEY) ?? ''
  } catch {
    return ''
  }
}

const writeSkippedVersion = (version: string) => {
  try {
    if (version) {
      localStorage.setItem(SKIPPED_VERSION_KEY, version)
    } else {
      localStorage.removeItem(SKIPPED_VERSION_KEY)
    }
  } catch {
    // 忽略本地存储失败
  }
}

type UpdaterStore = {
  checking: boolean
  modalOpen: boolean
  latest: ReleaseInfo | null
  hasUpdate: boolean
  lastCheckedAt: number | null
  error: string | null
  download: DownloadState
}

const EMPTY_DOWNLOAD: DownloadState = {
  status: 'idle',
  progress: 0,
  downloaded: 0,
  total: 0,
  error: '',
  hasDownloadedFile: false,
}

export const useUpdater = create<UpdaterStore>(() => ({
  checking: false,
  modalOpen: false,
  latest: null,
  hasUpdate: false,
  lastCheckedAt: null,
  error: null,
  download: EMPTY_DOWNLOAD,
}))

let pollTimer = 0

const stopPollingDownload = () => {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = 0
  }
}

const syncAndroidDownloadState = () => {
  const bridge = getAndroidBridge()
  if (!bridge?.getUpdateDownloadState) {
    stopPollingDownload()
    return
  }
  try {
    const parsed = JSON.parse(bridge.getUpdateDownloadState()) as Partial<DownloadState>
    const status = parsed.status ?? 'idle'
    useUpdater.setState({
      download: {
        status,
        progress: typeof parsed.progress === 'number' ? parsed.progress : 0,
        downloaded: typeof parsed.downloaded === 'number' ? parsed.downloaded : 0,
        total: typeof parsed.total === 'number' ? parsed.total : 0,
        error: typeof parsed.error === 'string' ? parsed.error : '',
        hasDownloadedFile: Boolean(parsed.hasDownloadedFile),
      },
    })
    if (status !== 'downloading') {
      stopPollingDownload()
    }
  } catch {
    stopPollingDownload()
  }
}

const isAllowedApkUrl = (raw: string | null | undefined): string | null => {
  const clean = sanitizeWebUrl(raw)
  if (!clean) {
    return null
  }
  try {
    const parsed = new URL(clean)
    if (parsed.protocol !== 'https:') {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'github.com' ||
      host === 'objects.githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    ) {
      return parsed.toString()
    }
    return null
  } catch {
    return null
  }
}
const parseGitHubRelease = (raw: unknown): ReleaseInfo | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const obj = raw as Record<string, unknown>
  const tagName = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : ''
  const version = normalizeVersion(tagName)
  if (!version) {
    return null
  }
  const assets = Array.isArray(obj.assets) ? obj.assets : []
  const apkAsset = assets.find(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      ((item as Record<string, unknown>).name as string).toLowerCase().endsWith('.apk')
  )
  const htmlUrl =
    typeof obj.html_url === 'string'
      ? (sanitizeWebUrl(obj.html_url) ?? GITHUB_RELEASES_URL)
      : GITHUB_RELEASES_URL
  const apkUrl =
    apkAsset && typeof apkAsset.browser_download_url === 'string'
      ? isAllowedApkUrl(apkAsset.browser_download_url)
      : null
  return {
    version,
    tagName,
    title: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `v${version}`,
    body: typeof obj.body === 'string' ? obj.body.trim() : '',
    publishedAt: typeof obj.published_at === 'string' ? obj.published_at : '',
    htmlUrl,
    apkUrl,
    apkName: apkAsset && typeof apkAsset.name === 'string' ? apkAsset.name : null,
    apkSize: apkAsset && typeof apkAsset.size === 'number' ? apkAsset.size : null,
  }
}

/** 从 GitHub Releases 检查最新版本并获取更新公告 */
export const checkForUpdates = async ({ manual = false } = {}): Promise<void> => {
  const current = getCurrentAppVersion()
  // APK 由本仓库单独签名发布，不能也不应自动追随上游版本提示。
  if (!manual && current.isAndroid) {
    return
  }
  if (useUpdater.getState().checking) {
    return
  }
  useUpdater.setState({ checking: true, error: null })
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 12000)

  try {
    const response = await fetchWithDevProxy(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })

    if (response.status === 404) {
      useUpdater.setState({
        checking: false,
        latest: null,
        hasUpdate: false,
        lastCheckedAt: Date.now(),
        error: null,
      })
      if (manual) {
        showToast({ key: 'updateNoReleasesToast' })
      }
      return
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const release = parseGitHubRelease(await response.json())
    if (!release) {
      throw new Error('Invalid release payload')
    }

    const hasUpdate = compareVersions(release.version, current.versionName) > 0
    const skipped = readSkippedVersion()

    useUpdater.setState({
      checking: false,
      latest: release,
      hasUpdate,
      lastCheckedAt: Date.now(),
      error: null,
      modalOpen: hasUpdate && (manual || skipped !== release.version),
    })

    if (manual && !hasUpdate) {
      showToast({ key: 'updateUpToDateToast', params: { version: current.versionName } })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useUpdater.setState({ checking: false, error: message })
    if (manual) {
      showToast({ type: 'error', key: 'updateCheckFailedToast', params: { message } })
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

export const openUpdateModal = () => {
  if (useUpdater.getState().latest) {
    useUpdater.setState({ modalOpen: true })
    if (useUpdater.getState().download.status === 'downloading') {
      syncAndroidDownloadState()
      stopPollingDownload()
      pollTimer = window.setInterval(syncAndroidDownloadState, 250)
    }
  }
}

export const dismissUpdateModal = () => {
  stopPollingDownload()
  useUpdater.setState({ modalOpen: false })
}

export const skipReleaseVersion = (version: string) => {
  writeSkippedVersion(version)
  dismissUpdateModal()
  showToast({ key: 'updateSkippedToast', params: { version } })
}

export const clearSkippedReleaseVersion = () => writeSkippedVersion('')

export const openReleaseInBrowser = (url?: string | null) => {
  const target =
    sanitizeWebUrl(url) ||
    sanitizeWebUrl(useUpdater.getState().latest?.htmlUrl) ||
    GITHUB_RELEASES_URL
  window.open(target, '_blank', 'noopener,noreferrer')
}

export const startUpdateInstall = () => {
  const { latest } = useUpdater.getState()
  if (!latest) {
    return
  }
  writeSkippedVersion('')
  const apkUrl = isAllowedApkUrl(latest.apkUrl)
  const bridge = getAndroidBridge()
  if (getCurrentAppVersion().isAndroid && apkUrl && bridge?.downloadAndInstallApk) {
    useUpdater.setState({
      download: {
        ...EMPTY_DOWNLOAD,
        status: 'downloading',
      },
    })
    bridge.downloadAndInstallApk(apkUrl, latest.apkName ?? 'XiaoShiLiu-update.apk')
    window.setTimeout(syncAndroidDownloadState, 100)
    pollTimer = window.setInterval(syncAndroidDownloadState, 250)
    return
  }
  openReleaseInBrowser(apkUrl ?? latest.htmlUrl)
}

export const retryPendingAndroidInstall = () => {
  const bridge = getAndroidBridge()
  if (bridge?.retryInstallDownloadedApk) {
    bridge.retryInstallDownloadedApk()
    window.setTimeout(syncAndroidDownloadState, 300)
  }
}
