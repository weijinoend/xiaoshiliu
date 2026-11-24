import { describe, expect, it } from 'vitest'
import { imageExtensionFromMime } from './format.js'

describe('imageExtensionFromMime', () => {
  it('keeps animated GIF extensions', () => {
    expect(imageExtensionFromMime('image/gif')).toBe('gif')
    expect(imageExtensionFromMime('image/webp')).toBe('webp')
    expect(imageExtensionFromMime('image/png')).toBe('png')
  })
})
