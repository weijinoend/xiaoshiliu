import type { MouseEvent } from 'react'
import { sanitizeWebUrl } from '../../services/api/origin.js'
import type { Source } from '../../services/chat/view.js'
import { HoverCard, type HoverCardTrigger } from './HoverCard.js'
import { SourceCard } from './SourceCard.js'

/**
 * 正文里 [citation:N] 的数字角标：悬停预览来源，点击新标签打开。
 * 角标使用带 link 角色的 span，可嵌入链接文字。样式由 .ds-markdown-cite 提供。
 */
export const CitationLink = ({ source }: { source: Source }) => {
  const safeUrl = sanitizeWebUrl(source.url)
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (safeUrl) {
      window.open(safeUrl, '_blank', 'noopener,noreferrer')
    }
  }
  const renderTrigger: HoverCardTrigger = ({ domRef, domProps }) => (
    <span ref={domRef} className="ds-markdown-cite" {...domProps} role="link" onClick={open}>
      {source.index}
    </span>
  )
  return (
    <HoverCard renderTrigger={renderTrigger}>
      <SourceCard source={source} />
    </HoverCard>
  )
}
