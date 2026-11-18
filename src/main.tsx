import './polyfills.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ErrorBoundary } from './components/base/ErrorBoundary.js'
import { ensureKatex } from './services/markdown/katex.js'
import { registerPwa } from './services/pwa.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
registerPwa()

createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
