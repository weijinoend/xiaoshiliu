import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryState = {
  error: Error | null
}

/** 全局异常兜底：避免极端老旧设备运行报错时直接陷入不可恢复的纯白/纯黑屏 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 错误详情直接展示在恢复面板中
  }

  override render() {
    if (!this.state.error) {
      return this.props.children
    }
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 12,
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1b1b1c)',
          textAlign: 'center',
          fontSize: 14,
          lineHeight: '22px',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600 }}>页面渲染遇到异常</div>
        <div
          style={{
            maxWidth: 420,
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid rgba(128,128,128,0.25)',
            fontSize: 12,
            wordBreak: 'break-word',
          }}
        >
          {this.state.error.message || String(this.state.error)}
        </div>
        <button
          type="button"
          style={{
            padding: '8px 18px',
            borderRadius: 999,
            border: 'none',
            background: '#3964fe',
            color: '#fff',
            fontSize: 14,
            cursor: 'pointer',
          }}
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    )
  }
}
