import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadFile } from '../../services/chat/db.js'
import {
  cancelImageGeneration,
  confirmImageGeneration,
  reuseGeneratedImageInDraft,
} from '../../services/chat/store.js'
import type { ImagePart } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconDownloadOutline16,
  IconEditOutline16,
  IconImageGen14,
  IconWarningOutline16,
} from '../base/icons.js'
import { ImageSizePicker } from './ImageSizePicker.js'
import { openImageViewer } from './imageViewerState.js'
import { showToast } from '../base/toastState.js'
import { saveDownloadedUrl } from '../../utils/download.js'
import styles from './AssistantMessage.module.css'

/**
 * 渲染生图块：
 * - pending_confirm：展示可微调提示词、尺寸选择器（图生图默认跟随原图比例）与「确认生图 / 取消」
 * - generating：展示生成中状态
 * - error：展示错误信息 + 「重试生图 / 取消」
 * - cancelled：展示已取消状态
 * - done：从 IndexedDB 加载图片，支持放大预览、以此图继续改图（图生图）与下载
 */
export const GeneratedImage = ({
  sessionId,
  messageId,
  blockIndex,
  block,
  busy,
}: {
  sessionId: string
  messageId: string
  blockIndex: number
  block: ImagePart
  busy: boolean
}) => {
  const t = useTranslate()
  const defaultSize = useSettings((state) => state.imageGenChannel.size)
  const hasReference = (block.sourceFileIds?.length ?? 0) > 0
  const [url, setUrl] = useState<string | null>(null)
  const [promptDraft, setPromptDraft] = useState(block.prompt ?? '')
  const [sizeDraft, setSizeDraft] = useState(
    block.size || (hasReference ? 'match' : defaultSize || 'auto')
  )

  useEffect(() => {
    setPromptDraft(block.prompt ?? '')
  }, [block.prompt])

  useEffect(() => {
    setSizeDraft(block.size || (hasReference ? 'match' : defaultSize || 'auto'))
  }, [block.size, hasReference, defaultSize])

  useEffect(() => {
    if (!block.fileId) {
      setUrl(null)
      return
    }
    let active = true
    let objectUrl: string | null = null
    void loadFile(block.fileId)
      .then((blob) => {
        if (!active || !blob) {
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      active = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [block.fileId])

  const status = block.status ?? (block.fileId ? 'done' : 'pending_confirm')

  if (status === 'cancelled') {
    return <div className={styles.imageGenMutedCard}>{t('imageGenCancelled')}</div>
  }

  if (status === 'generating') {
    return (
      <div className={styles.imageGenConfirmCard}>
        <div className={styles.imageGenHeader}>
          <IconImageGen14 />
          <span>{t('imageGenGenerating')}</span>
          {block.size ? <span className={styles.imageGenSizeBadge}>{block.size}</span> : null}
        </div>
        {block.prompt ? <div className={styles.imageGenPromptText}>{block.prompt}</div> : null}
      </div>
    )
  }

  if (status === 'pending_confirm' || status === 'error') {
    const isError = status === 'error'
    return (
      <div className={styles.imageGenConfirmCard}>
        <div className={styles.imageGenHeader}>
          {isError ? <IconWarningOutline16 /> : <IconImageGen14 />}
          <span>{isError ? t('imageGenFailed') : t('imageGenConfirmTitle')}</span>
          {hasReference ? (
            <span className={styles.imageGenSizeBadge}>
              {t('imageGenImg2ImgBadge', { count: block.sourceFileIds?.length ?? 0 })}
            </span>
          ) : null}
        </div>
        {isError && block.error ? <div className={styles.imageGenError}>{block.error}</div> : null}
        <textarea
          className={styles.imageGenPromptInput}
          rows={2}
          disabled={busy}
          value={promptDraft}
          onChange={(event) => setPromptDraft(event.target.value)}
        />
        <ImageSizePicker value={sizeDraft} hasReference={hasReference} onChange={setSizeDraft} />
        <div className={styles.imageGenConfirmActions}>
          <Button
            size="s"
            variant="outlined"
            disabled={busy}
            onClick={() => cancelImageGeneration(sessionId, messageId, blockIndex)}
          >
            {t('cancel')}
          </Button>
          <Button
            size="s"
            disabled={busy || !promptDraft.trim()}
            onClick={() =>
              void confirmImageGeneration(sessionId, messageId, blockIndex, promptDraft, sizeDraft)
            }
          >
            {isError ? t('imageGenRetryButton') : t('imageGenConfirmButton')}
          </Button>
        </div>
      </div>
    )
  }

  if (!url) {
    return null
  }

  const ext = block.mimeType.includes('jpeg')
    ? 'jpg'
    : block.mimeType.includes('webp')
      ? 'webp'
      : 'png'

  const download = () => {
    void saveDownloadedUrl(url, `generated-${block.fileId.slice(0, 8)}.${ext}`)
      .then((dest) => {
        if (dest === 'browser') {
          showToast({ key: 'imageSavedToast' })
        }
      })
      .catch(() => {
        showToast({ key: 'imageSaveFailedToast' })
      })
  }

  return (
    <div className={styles.generatedImageCard}>
      <img
        src={url}
        alt={block.prompt ?? 'Generated image'}
        className={styles.generatedImage}
        onClick={() =>
          openImageViewer({
            src: url,
            fileId: block.fileId,
            alt: block.prompt ?? 'Generated image',
            filename: `generated-${block.fileId.slice(0, 8)}.${ext}`,
          })
        }
      />
      <div className={styles.generatedImageFooter}>
        <span className={styles.generatedImagePrompt}>
          {block.prompt ? `${t('imageGenPromptLabel')}: ${block.prompt}` : ''}
        </span>
        <div className={styles.generatedImageActions}>
          <IconButton
            icon={<IconEditOutline16 />}
            tooltip={t('imageGenReuseButton')}
            onClick={() => void reuseGeneratedImageInDraft(sessionId, block.fileId, block.mimeType)}
          />
          <IconButton
            icon={<IconDownloadOutline16 />}
            tooltip={t('imageGenDownload')}
            onClick={download}
          />
        </div>
      </div>
    </div>
  )
}
