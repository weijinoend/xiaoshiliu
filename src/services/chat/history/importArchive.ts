import * as db from '../db.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

const SESSION_BATCH_SIZE = 100
const FILE_BATCH_MAX_COUNT = 40
const FILE_BATCH_MAX_BYTES = 8 * 1024 * 1024
const DEFERRED_IMAGE_MAX_BYTES = 64 * 1024 * 1024

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
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
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const isJunkEntry = (path: string): boolean => {
  if (path.startsWith('__MACOSX/')) {
    return true
  }
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._')
}

/** 检测单个目录层级内的 manifest 路径，返回外层目录前缀（无外层目录时为空字符串） */
const matchManifestPrefix = (path: string): string | null => {
  if (path === MANIFEST_PATH) {
    return ''
  }
  const slash = path.indexOf('/')
  if (slash > 0 && path.slice(slash + 1) === MANIFEST_PATH) {
    return path.slice(0, slash + 1)
  }
  return null
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、manifest 条目及格式版本（支持单层目录及任意条目顺序），并返回外层目录前缀。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<string> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (isJunkEntry(entry.path)) {
        await skipEntry(entry)
        continue
      }
      const prefix = matchManifestPrefix(entry.path)
      if (prefix !== null) {
        checkManifest(await readJson(entry))
        return prefix
      }
      await skipEntry(entry)
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  return fail('backupUnrecognized')
}

/**
 * 流式导入：支持标准 DeepSeek 导出顺序及重打包顺序，批量写入暂存 IndexedDB 提升大归档导入速度。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  file: File,
  onProgress?: (sessions: number) => void,
  knownRootPrefix?: string
): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  /** 重打包归档中若图片条目先于对应会话 JSON 出现，暂存等待会话解析后立刻关联。 */
  const deferredImages = new Map<string, Blob>()
  let deferredBytes = 0
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let rootPrefix: string | null = knownRootPrefix ?? null
  let sessionBatch: Session[] = []
  let fileBatch: db.StoredFile[] = []
  let fileBatchBytes = 0

  const flushSessions = async () => {
    if (sessionBatch.length === 0) {
      return
    }
    const batch = sessionBatch
    sessionBatch = []
    await db.addStagingSessions(batch)
  }

  const flushFiles = async () => {
    if (fileBatch.length === 0) {
      return
    }
    const batch = fileBatch
    fileBatch = []
    fileBatchBytes = 0
    await db.saveStagingFiles(batch)
  }

  const saveImageBlob = async (data: Blob, id: string) => {
    if (stored.has(id)) {
      return
    }
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    const blob = new Blob([data], { type })
    stored.set(id, type)
    fileBatch.push({ id, blob })
    fileBatchBytes += blob.size
    if (fileBatch.length >= FILE_BATCH_MAX_COUNT || fileBatchBytes >= FILE_BATCH_MAX_BYTES) {
      await flushFiles()
    }
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    await saveImageBlob(await readEntry(entry), id)
  }

  try {
    for await (const entry of readArchive(file)) {
      if (isJunkEntry(entry.path)) {
        await skipEntry(entry)
        continue
      }
      if (rootPrefix === null) {
        rootPrefix = matchManifestPrefix(entry.path) ?? fail('backupUnrecognized')
      }
      if (rootPrefix && !entry.path.startsWith(rootPrefix)) {
        fail('backupIncomplete')
      }
      const path = entry.path.slice(rootPrefix.length)
      const sessionId = parseSessionPath(path)
      const fileDirMatch = /^chat_sessions\/([^/]+)_files\//.exec(path)
      if (path === MANIFEST_PATH && !manifest) {
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
          const pending = deferredImages.get(imagePath)
          if (pending) {
            deferredImages.delete(imagePath)
            deferredBytes -= pending.size
            await saveImageBlob(pending, id)
          }
        }
        sessionBatch.push(local.session)
        if (sessionBatch.length >= SESSION_BATCH_SIZE) {
          await flushSessions()
        }
        onProgress?.(imported.size)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (fileDirMatch) {
        const id = images.get(path)
        if (id !== undefined) {
          await saveImage(entry, id)
        } else if (!imported.has(fileDirMatch[1]) && deferredBytes + entry.size <= DEFERRED_IMAGE_MAX_BYTES) {
          const data = await readEntry(entry)
          deferredImages.set(path, data)
          deferredBytes += data.size
        } else {
          // 所属会话已解析仍未引用该路径，或超额孤立文件，直接跳过。
          await skipEntry(entry)
        }
      } else if (!path.includes('/')) {
        // 兼容未来新增的顶层元信息文件（如记忆/分组配置）
        await skipEntry(entry)
      } else {
        fail('backupIncomplete')
      }
    }
    deferredImages.clear()
    await flushSessions()
    await flushFiles()
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
}
