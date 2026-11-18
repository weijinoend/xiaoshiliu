import { create } from 'zustand'

export type SearchScrollTarget = {
  sessionId: string
  messageId: string
  nonce: number
}

type SessionSearchState = {
  open: boolean
  targetScroll: SearchScrollTarget | null
}

export const useSessionSearch = create<SessionSearchState>(() => ({
  open: false,
  targetScroll: null,
}))

export const openSessionSearch = () => {
  useSessionSearch.setState({ open: true })
}

export const closeSessionSearch = () => {
  if (!useSessionSearch.getState().open) {
    return false
  }
  useSessionSearch.setState({ open: false })
  return true
}

export const setSearchScrollTarget = (sessionId: string, messageId: string) => {
  useSessionSearch.setState({
    targetScroll: { sessionId, messageId, nonce: Date.now() },
  })
}

export const clearSearchScrollTarget = (nonce?: number) => {
  const current = useSessionSearch.getState().targetScroll
  if (!current || (nonce !== undefined && current.nonce !== nonce)) {
    return
  }
  useSessionSearch.setState({ targetScroll: null })
}
