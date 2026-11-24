import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose } from './api/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  if (classifyApiError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 识别图片前 16 字节魔数，避免归档导入或重命名导致 MIME 缺失或失真。 */
const detectImageMimeFromBytes = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (
    header.slice(4, 8) === 'ftyp' &&
    ['avif', 'avis', 'heic', 'heif'].includes(header.slice(8, 12))
  ) {
    return 'image/avif'
  }
  return ''
}

const MAX_NORMALIZED_IMAGE_EDGE = 2048

const decodeAndConvertImage = async (blob: Blob, targetMime: 'image/jpeg' | 'image/png') => {
  let width = 0
  let height = 0
  let drawSource: CanvasImageSource
  let cleanup: (() => void) | null = null

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    width = bitmap.width
    height = bitmap.height
    drawSource = bitmap
    cleanup = () => bitmap.close()
  } else {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('Invalid image'))
        element.src = objectUrl
      })
      width = img.naturalWidth || img.width
      height = img.naturalHeight || img.height
      drawSource = img
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  try {
    if (width <= 0 || height <= 0) {
      throw new Error('Empty image dimensions')
    }
    const scale = Math.min(1, MAX_NORMALIZED_IMAGE_EDGE / Math.max(width, height))
    const targetW = Math.max(1, Math.round(width * scale))
    const targetH = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Canvas unavailable')
    }
    if (targetMime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, targetW, targetH)
    }
    ctx.drawImage(drawSource, 0, 0, targetW, targetH)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (converted) => {
          if (converted && converted.size > 0) {
            resolve(converted)
          } else {
            reject(new Error('Image transcode failed'))
          }
        },
        targetMime,
        targetMime === 'image/jpeg' ? 0.9 : undefined
      )
    })
  } finally {
    cleanup?.()
  }
}

/**
 * 上传前规范化图片：
 * - PNG / JPEG 原样保留并补正真实 MIME；
 * - WebP / BMP / TIFF / AVIF / GIF 或空 MIME 的历史图片自动转为标准 JPEG/PNG，防止模型接口报错。
 */
const normalizeImageForUpload = async (
  blob: Blob,
  name: string
): Promise<{ blob: Blob; name: string }> => {
  if (blob.size === 0) {
    throw new Error('Empty image file')
  }
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const detected = detectImageMimeFromBytes(head)
  if ((detected === 'image/jpeg' || detected === 'image/png') && blob.size <= 16 * 1024 * 1024) {
    const fixedBlob = blob.type === detected ? blob : new Blob([blob], { type: detected })
    return { blob: fixedBlob, name }
  }
  const targetMime = detected === 'image/png' ? 'image/png' : 'image/jpeg'
  const converted = await decodeAndConvertImage(blob, targetMime)
  const baseName = name.replace(/\.[^.]+$/, '') || 'image'
  const ext = targetMime === 'image/png' ? 'png' : 'jpg'
  return { blob: converted, name: `${baseName}.${ext}` }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal
) =>
  new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const prepared = isImage ? await normalizeImageForUpload(file, name) : { blob: file, name }
        const body =
          prepared.blob instanceof File
            ? prepared.blob
            : new File([prepared.blob], prepared.name, { type: prepared.blob.type })
        resolve(
          (await uploadFile(apiKey, body, getUploadPurpose(prepared.name, isImage), signal)).id
        )
      } catch (error) {
        reject(error)
      }
    })
    next()
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/** 开始（或复用进行中的）上传，返回服务端 file_id；失败时任务记为 error 并抛出原错误 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = enqueueUpload(apiKey, blob, name, isImage, controller.signal)
    .then((serverId) => {
      setTask(id, { status: 'done', serverId })
      return serverId
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => {
      if (pending.get(id)?.controller === controller) {
        pending.delete(id)
      }
    })
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  const current = pending.get(id)
  if (current) {
    pending.delete(id)
    current.controller.abort()
  }
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
