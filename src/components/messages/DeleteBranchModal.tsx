import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'

/** 删除分支确认弹窗（共用组件：用户消息 / 助手消息） */
export const DeleteBranchModal = ({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('deleteBranchConfirmTitle')}
      closable
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {t('deleteBranchConfirmAction')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{t('deleteBranchConfirmBody')}</p>
    </Modal>
  )
}
