import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  onOpenChange,
  children,
}: {
  options: MenuOption[]
  onOpenChange?: (open: boolean) => void
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  useEffect(() => {
    if (!open) {
      return
    }
    return registerAndroidBackHandler(100, () => {
      setOpen(false)
      return true
    })
  }, [open])
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  tabIndex={0}
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    setOpen(false)
                    option.onSelect()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setOpen(false)
                      option.onSelect()
                    }
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
