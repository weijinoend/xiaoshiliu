import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  IconBranchOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply } from '../../services/chat/reply.js'
import {
  continueReply,
  deleteMessageBranch,
  editAssistantMessage,
  forkSessionFromMessage,
  regenerateReply,
} from '../../services/chat/store.js'
import { showToast } from '../base/toastState.js'
import { useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { DeleteBranchModal } from './DeleteBranchModal.js'
import { GeneratedImage } from './GeneratedImage.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const keepRefusedContent = useSettings((state) => state.keepRefusedContent)
  const allowRefusedContext = useSettings((state) => state.allowRefusedContext)
  const allowEditAssistant = useSettings((state) => state.allowEditAssistant)
  const refusalMessage = useSettings((state) => state.refusalMessage)
  const avatarEnabled = useSettings((state) => state.avatarEnabled)
  const avatarDataUrl = useSettings((state) => state.avatarDataUrl)
  const avatarShape = useSettings((state) => state.avatarShape)
  const avatarSize = useSettings((state) => state.avatarSize)
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  // 默认安全拒绝时按协议丢弃思考与正文；开启 keepRefusedContent 后保留已下发内容。
  const refused = !keepRefusedContent && message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const notice = streaming
    ? null
    : describeReply(message, { refusalMessage, hasVisibleAnswer: !!answer })
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const generatedImages = refused
    ? []
    : message.blocks.flatMap((block, index) => (block.type === 'image' ? [{ block, index }] : []))
  const copyText = responseText || notice?.text
  const inputTokens = message.usage
    ? message.usage.input_tokens +
      message.usage.cache_creation_input_tokens +
      message.usage.cache_read_input_tokens
    : 0
  const outputTokens = message.usage?.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  const waiting =
    streaming &&
    view.steps.length === 0 &&
    !view.answer &&
    !message.thinking &&
    generatedImages.length === 0
  const summaryEntry = `${message.id}-summary`

  const [editing, setEditing] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSaveEdit = !busy && draft.trim() !== ''

  useEffect(() => {
    setEditing(false)
  }, [message.id])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 360)}px`
    }
  }, [editing, draft])

  const saveEdit = () => {
    if (canSaveEdit && editAssistantMessage(sessionId, message.id, draft)) {
      stopReadAloud()
      setEditing(false)
    }
  }

  return (
    <div className={styles.message}>
      {avatarEnabled && avatarDataUrl ? (
        <div className={styles.avatarRow}>
          <img
            src={avatarDataUrl}
            alt=""
            className={clsx(
              styles.avatarImg,
              avatarShape === 'circle' ? styles.avatarCircle : styles.avatarSquare
            )}
            style={{ width: avatarSize, height: avatarSize }}
          />
        </div>
      ) : null}
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editReply')}
            autoFocus
            rows={3}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (!isMobile && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                saveEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSaveEdit} onClick={saveEdit}>
              {t('save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {answer ? (
            <Markdown
              className="ds-assistant-message-main-content"
              content={answer.markdown}
              loading={streaming}
              cacheKey={message.id}
              disableLink={false}
              sources={view.sources}
            />
          ) : null}
          {generatedImages.length > 0 ? (
            <div className={styles.generatedImages}>
              {generatedImages.map(({ block, index }) => (
                <GeneratedImage
                  key={`${message.id}-img-${index}`}
                  sessionId={sessionId}
                  messageId={message.id}
                  blockIndex={index}
                  block={block}
                  busy={busy}
                />
              ))}
            </div>
          ) : null}
          {waiting ? (
            <div className={styles.waiting}>
              {[0, 1, 2].map((index) => (
                <span key={index} className={styles.waitingDot} />
              ))}
            </div>
          ) : null}
          {notice?.presentation === 'response' ? (
            <Markdown
              className="ds-assistant-message-main-content"
              content={notice.text}
              loading={false}
              cacheKey={`${message.id}-template`}
              disableLink={false}
            />
          ) : notice ? (
            <div className={styles.notice}>
              <IconWarningOutline16 />
              <span>
                {notice.text}
                {notice.action === 'apiKey' ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={styles.noticeAction}
                      onClick={() => openSettings('model')}
                    >
                      {t('changeApiKey')}
                    </button>
                  </>
                ) : null}
                {notice.action === 'topUp' ? (
                  <>
                    {' '}
                    <a
                      className={styles.noticeAction}
                      href={TOP_UP_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('topUp')}
                    </a>
                  </>
                ) : null}
              </span>
            </div>
          ) : null}
          {!streaming && !refused && view.searchResults.length > 0 ? (
            <div
              className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
              onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
            >
              <SiteThumbnails sources={view.searchResults} />
              <span>
                {t(
                  view.searchResults.length === 1
                    ? 'messageSearchSummary'
                    : 'messageSearchSummaries',
                  { count: view.searchResults.length }
                )}
              </span>
            </div>
          ) : null}
          {streaming ? null : (
            <>
              <div className={styles.bottom}>
                <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
                <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
                  {copyText ? <CopyButton text={copyText} /> : null}
                  {allowEditAssistant ? (
                    <IconButton
                      icon={<IconEditOutline16 />}
                      tooltip={t('editReply')}
                      tooltipPlacement="bottom"
                      disabled={busy}
                      onClick={() => {
                        setDraft(responseText || notice?.text || '')
                        setEditing(true)
                      }}
                    />
                  ) : null}
                  {responseText && !refused ? (
                    <ReadAloudButton messageId={message.id} text={responseText} />
                  ) : null}
                  <IconButton
                    icon={<IconRefreshOutline16 />}
                    tooltip={t('regenerate')}
                    tooltipPlacement="bottom"
                    disabled={busy || (refused && !allowRefusedContext)}
                    onClick={() => {
                      stopReadAloud()
                      regenerateReply(sessionId, message.id)
                    }}
                  />
                  <IconButton
                    icon={<IconBranchOutline16 />}
                    tooltip={t('branchChat')}
                    tooltipPlacement="bottom"
                    disabled={busy}
                    onClick={() => {
                      stopReadAloud()
                      if (forkSessionFromMessage(sessionId, message.id)) {
                        showToast({ key: 'branchChatToast' })
                      }
                    }}
                  />
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    tooltip={t('deleteBranch')}
                    tooltipPlacement="bottom"
                    disabled={busy}
                    onClick={() => setConfirmDeleteOpen(true)}
                  />
                </div>
                {isLast && canContinueReply(message, allowRefusedContext) ? (
                  <Button
                    variant="outlined"
                    size="s"
                    className={styles.continueButton}
                    disabled={busy}
                    onClick={() => {
                      stopReadAloud()
                      continueReply(sessionId, message.id)
                    }}
                  >
                    {t('continueGenerating')}
                  </Button>
                ) : null}
              </div>
              {totalTokens > 0 ? (
                <div className={styles.tokenUsage}>
                  {t('tokenUsageSummary', {
                    total: totalTokens,
                    input: inputTokens,
                    output: outputTokens,
                  })}
                </div>
              ) : null}
              <DeleteBranchModal
                open={confirmDeleteOpen}
                onClose={() => setConfirmDeleteOpen(false)}
                onConfirm={() => {
                  stopReadAloud()
                  deleteMessageBranch(sessionId, message.id)
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  )
})
