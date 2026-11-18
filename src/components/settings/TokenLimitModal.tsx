import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { dismissTokenLimitModal, useDailyTokenUsage } from '../../services/tokenUsage.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from './settingsDialogState.js'

const fmt = (n: number) => n.toLocaleString()

/** 今日 Token 用量达到自定义阈值时的弹窗提醒 */
export const TokenLimitModal = () => {
  const t = useTranslate()
  const open = useDailyTokenUsage((state) => state.limitModalOpen)
  const totalTokens = useDailyTokenUsage((state) => state.totalTokens)
  const inputTokens = useDailyTokenUsage((state) => state.inputTokens)
  const outputTokens = useDailyTokenUsage((state) => state.outputTokens)
  const dailyTokenLimit = useSettings((state) => state.dailyTokenLimit)

  if (!open) {
    return null
  }

  return (
    <Modal
      title={t('tokenLimitModalTitle')}
      closable
      onClose={dismissTokenLimitModal}
      footer={
        <>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              dismissTokenLimitModal()
              openSettings('general')
            }}
          >
            {t('tokenLimitModalAdjust')}
          </Button>
          <Button variant="primary" size="m" autoFocus onClick={dismissTokenLimitModal}>
            {t('tokenLimitModalContinue')}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 14, lineHeight: '22px' }}>
        {t('tokenLimitModalBody', {
          total: fmt(totalTokens),
          input: fmt(inputTokens),
          output: fmt(outputTokens),
          limit: fmt(dailyTokenLimit),
        })}
      </div>
    </Modal>
  )
}
