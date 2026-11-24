import { describe, expect, it } from 'vitest'
import type { Session } from '../types.js'
import { toSessionFile } from './toArchive.js'

describe('toSessionFile', () => {
  it('exports non-image attachment originals when a local path is available', () => {
    const session: Session = {
      id: 'session-1',
      title: 'Attachment',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          createdAt: 1,
          content: 'read this',
          files: [
            {
              id: 'file-1',
              serverId: null,
              name: 'report.pdf',
              size: 12,
              isImage: false,
              mimeType: 'application/pdf',
            },
          ],
        },
      ],
    }

    const archived = toSessionFile(session, ({ id }) => `chat_sessions/session-1_files/${id}`)
    const fileFragment = archived.messages[0].fragments.find((item) => item.type === 'FILE')

    expect(fileFragment).toMatchObject({
      type: 'FILE',
      files: [
        {
          id: 'file-1',
          is_image: false,
          export_path: 'chat_sessions/session-1_files/file-1',
        },
      ],
    })
  })
})
