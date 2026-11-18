import clsx from 'clsx'
import {
  IconMenuOutline20,
  IconNewChatOutline20,
  IconVolumeOffOutline20,
  IconVolumeOnOutline20,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { setAutoPlayVoice, useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 右上角语音自动播报小喇叭开关按钮（桌面与移动端共用） */
export const AutoPlayVoiceButton = ({ size = 'xl' }: { size?: 'm' | 'xl' }) => {
  const t = useTranslate()
  const autoPlayVoice = useSettings((state) => state.autoPlayVoice)
  return (
    <IconButton
      size={size}
      tone="primary"
      className={clsx(autoPlayVoice && styles.speakerActive)}
      icon={autoPlayVoice ? <IconVolumeOnOutline20 /> : <IconVolumeOffOutline20 />}
      tooltip={t(autoPlayVoice ? 'autoPlayVoiceDisableTooltip' : 'autoPlayVoiceEnableTooltip')}
      tooltipPlacement="bottom"
      aria-pressed={autoPlayVoice}
      onClick={() => {
        const next = !autoPlayVoice
        setAutoPlayVoice(next)
        if (!next) {
          stopReadAloud()
        }
        showToast({ key: next ? 'autoPlayVoiceOnToast' : 'autoPlayVoiceOffToast' })
      }}
    />
  )
}

/** 移动端顶栏：左侧菜单打开侧边栏；右侧小喇叭控制语音自动播报与新增对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      <div className={styles.title}>{title ?? ''}</div>
      <div className={styles.actions}>
        <AutoPlayVoiceButton size="xl" />
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
