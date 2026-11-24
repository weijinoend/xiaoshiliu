import * as db from '../db.js'
import type { Session } from '../types.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 按导出格式生成 ZIP：manifest → 全部会话 JSON → index → 全部附件。没有账号信息，不写 user.json。
 * 本地存在原件的所有附件都会写入会话目录；缺失原件时保留元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const fileEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (!originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      } else {
        for (const block of message.blocks) {
          if (block.type === 'image' && block.fileId && !originals.has(block.fileId)) {
            originals.set(block.fileId, await db.loadFile(block.fileId))
          }
        }
      }
    }
    const attachments = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name }) => {
      const blob = originals.get(id)
      if (!blob) {
        return null
      }
      const path = imagePath(session.id, id, name)
      attachments.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of attachments) {
      fileEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(fileEntries))
}
