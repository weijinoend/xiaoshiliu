import { create } from 'zustand'

export type ImageViewerPayload = {
  src: string
  fileId?: string
  alt?: string
  filename?: string
}

type ImageViewerState = {
  current: ImageViewerPayload | null
}

export const useImageViewer = create<ImageViewerState>(() => ({
  current: null,
}))

export const openImageViewer = (payload: ImageViewerPayload) => {
  useImageViewer.setState({ current: payload })
}

export const closeImageViewer = () => {
  if (!useImageViewer.getState().current) {
    return false
  }
  useImageViewer.setState({ current: null })
  return true
}
