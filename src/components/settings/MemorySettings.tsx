import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addSavedMemory,
  clearSavedMemories,
  deleteSavedMemory,
  toggleSavedMemory,
  updateSavedMemory,
  useSavedMemories,
} from '../../services/chat/savedMemory.js'
import {
  setAutoExtractMemory,
  setCrossChatMemory,
  setCrossChatMemoryLimit,
  setCrossChatMemoryScope,
  setCrossChatMemorySessionIds,
  setMemoryUpdateNotice,
  setSavedMemoryEnabled,
  toggleCrossChatMemorySession,
  useSettings,
} from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { formatDate } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { NumberParamInput, ToggleCell, ToggleSwitch } from './ModelSettings.js'
import styles from './Settings.module.css'

/** 长期记忆管理与跨对话记忆设置 */
export const MemorySettings = () => {
  const t = useTranslate()
  const settings = useSettings()
  const sessions = useChatStore((state) => state.sessions)
  const items = useSavedMemories((state) => state.items)
  const [newText, setNewText] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const handleAdd = () => {
    if (addSavedMemory(newText)) {
      setNewText('')
    }
  }

  const handleSaveEdit = (id: string) => {
    if (updateSavedMemory(id, editDraft)) {
      setEditingId(null)
    }
  }

  return (
    <>
      <div className={styles.groupTitle}>{t('memorySectionSaved')}</div>

      <ToggleCell
        label={t('memorySavedEnabledLabel')}
        description={t('memorySavedEnabledDesc')}
        checked={settings.savedMemoryEnabled}
        onChange={setSavedMemoryEnabled}
      />

      <ToggleCell
        label={t('memoryAutoExtractLabel')}
        description={t('memoryAutoExtractDesc')}
        checked={settings.autoExtractMemory}
        onChange={setAutoExtractMemory}
      />

      <ToggleCell
        label={t('memoryUpdateNoticeLabel')}
        description={t('memoryUpdateNoticeDesc')}
        checked={settings.memoryUpdateNotice}
        onChange={setMemoryUpdateNotice}
      />

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.memoryAddRow}>
            <input
              type="text"
              className={clsx(styles.textInput, styles.memoryAddInput)}
              placeholder={t('memoryAddPlaceholder')}
              value={newText}
              onChange={(event) => setNewText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  handleAdd()
                }
              }}
            />
            <Button size="m" disabled={!newText.trim()} onClick={handleAdd}>
              {t('memoryAddButton')}
            </Button>
          </div>

          {items.length > 0 ? (
            <div className={styles.memoryList}>
              {items.map((item) => {
                const isEditing = editingId === item.id
                return (
                  <div
                    key={item.id}
                    className={clsx(styles.memoryItem, !item.enabled && styles.memoryItemDisabled)}
                  >
                    {isEditing ? (
                      <div className={styles.memoryEditBox}>
                        <textarea
                          className={styles.textareaInput}
                          autoFocus
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setEditingId(null)
                            } else if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault()
                              handleSaveEdit(item.id)
                            }
                          }}
                        />
                        <div className={styles.memoryEditActions}>
                          <Button size="s" variant="outlined" onClick={() => setEditingId(null)}>
                            {t('cancel')}
                          </Button>
                          <Button
                            size="s"
                            disabled={!editDraft.trim()}
                            onClick={() => handleSaveEdit(item.id)}
                          >
                            {t('save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={styles.memoryContent}>{item.content}</div>
                        <div className={styles.memoryActions}>
                          <ToggleSwitch
                            checked={item.enabled}
                            ariaLabel={item.content}
                            onChange={() => toggleSavedMemory(item.id)}
                          />
                          <IconButton
                            icon={<IconEditOutline16 />}
                            tooltip={t('memoryEditTooltip')}
                            onClick={() => {
                              setEditingId(item.id)
                              setEditDraft(item.content)
                            }}
                          />
                          <IconButton
                            icon={<IconTrashOutline16 />}
                            tooltip={t('memoryDeleteTooltip')}
                            onClick={() => deleteSavedMemory(item.id)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={styles.memoryEmpty}>{t('memoryEmpty')}</div>
          )}

          {items.length > 0 ? (
            <div className={styles.resetRow}>
              <Button variant="dangerOutlined" size="s" onClick={clearSavedMemories}>
                {t('memoryClearAll')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.groupTitle}>{t('memorySectionCrossChat')}</div>

      <ToggleCell
        label={t('modelSettingsCrossChatMemoryLabel')}
        description={t('modelSettingsCrossChatMemoryDesc')}
        checked={settings.crossChatMemory}
        onChange={setCrossChatMemory}
      />

      {settings.crossChatMemory ? (
        <>
          <div className={`${styles.cell} ${styles.row}`}>
            <div className={styles.text}>
              <div className={styles.label}>{t('crossChatScopeLabel')}</div>
              <div className={styles.description}>{t('crossChatScopeDesc')}</div>
            </div>
            <div className={styles.presetRow}>
              <button
                type="button"
                className={clsx(
                  styles.presetPill,
                  settings.crossChatMemoryScope === 'all' && styles.presetPillActive
                )}
                onClick={() => setCrossChatMemoryScope('all')}
              >
                {t('crossChatScopeAll')}
              </button>
              <button
                type="button"
                className={clsx(
                  styles.presetPill,
                  settings.crossChatMemoryScope === 'selected' && styles.presetPillActive
                )}
                onClick={() => setCrossChatMemoryScope('selected')}
              >
                {t('crossChatScopeSelected')}
              </button>
            </div>
          </div>

          {settings.crossChatMemoryScope === 'selected' ? (
            <div className={styles.cell}>
              <div className={styles.field}>
                <div className={styles.linkedHeaderRow}>
                  <span className={styles.description}>
                    {t('crossChatLinkedTitle', {
                      count: settings.crossChatMemorySessionIds.filter((id) =>
                        sessions.some((s) => s.id === id)
                      ).length,
                    })}
                  </span>
                  {settings.crossChatMemorySessionIds.length > 0 ? (
                    <Button
                      size="s"
                      variant="outlined"
                      onClick={() => setCrossChatMemorySessionIds([])}
                    >
                      {t('crossChatLinkedClear')}
                    </Button>
                  ) : null}
                </div>
                <input
                  type="text"
                  className={styles.textInput}
                  placeholder={t('crossChatLinkedFilterPlaceholder')}
                  value={sessionFilter}
                  onChange={(event) => setSessionFilter(event.target.value)}
                />
                {sessions.length > 0 ? (
                  <div className={styles.linkedSessionList}>
                    {sessions
                      .filter((session) => {
                        const q = sessionFilter.trim().toLowerCase()
                        if (!q) {
                          return true
                        }
                        return (session.title || t('untitledChat')).toLowerCase().includes(q)
                      })
                      .map((session) => {
                        const checked = settings.crossChatMemorySessionIds.includes(session.id)
                        return (
                          <label
                            key={session.id}
                            className={clsx(
                              styles.linkedSessionItem,
                              checked && styles.linkedSessionItemChecked
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCrossChatMemorySession(session.id)}
                            />
                            <span className={styles.linkedSessionTitle}>
                              {session.title || t('untitledChat')}
                            </span>
                            <span className={styles.linkedSessionDate}>
                              {formatDate(new Date(session.updatedAt))}
                            </span>
                          </label>
                        )
                      })}
                  </div>
                ) : (
                  <div className={styles.memoryEmpty}>{t('crossChatLinkedEmpty')}</div>
                )}
              </div>
            </div>
          ) : (
            <div className={`${styles.cell} ${styles.row}`}>
              <div className={styles.text}>
                <div className={styles.label}>{t('modelSettingsCrossChatMemoryLimitLabel')}</div>
                <div className={styles.description}>
                  {t('modelSettingsCrossChatMemoryLimitDesc')}
                </div>
              </div>
              <div style={{ width: 84 }}>
                <NumberParamInput
                  label=""
                  value={settings.crossChatMemoryLimit}
                  placeholder="4"
                  step="1"
                  min={1}
                  max={10}
                  integer
                  onChange={(next) => setCrossChatMemoryLimit(next ?? 4)}
                />
              </div>
            </div>
          )}
        </>
      ) : null}
    </>
  )
}
