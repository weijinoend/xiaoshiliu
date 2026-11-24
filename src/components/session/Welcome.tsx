import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings, type ReplyMode } from '../../services/settings.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import brandUrl from '../../../assets/brand.webp'
import poseDefault from '../../../assets/pose-default.webp'
import poseDebate from '../../../assets/pose-debate.webp'
import poseObjective from '../../../assets/pose-objective.webp'
import poseValidate from '../../../assets/pose-validate.webp'
import styles from './Welcome.module.css'

const poseByMode: Record<ReplyMode, string> = {
  default: poseDefault,
  debate: poseDebate,
  objective: poseObjective,
  validate: poseValidate,
}

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const replyMode = useSettings((state) => state.replyMode)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.heroArea}>
          <div className={styles.hero}>
            <div className={styles.brandMarkFrame}>
              <img
                className={styles.brandMark}
                src={poseByMode[replyMode] ?? brandUrl}
                alt={t('appName')}
              />
            </div>
            <div className={styles.brandName}>{t('appName')}</div>
            <div className={styles.tagline}>{t('appTagline')}</div>
            <div className={styles.featureRow}>
              <span>{t('heroFeatureChat')}</span>
              <span>{t('heroFeatureImage')}</span>
              <span>{t('heroFeatureLocal')}</span>
            </div>
          </div>
        </div>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
