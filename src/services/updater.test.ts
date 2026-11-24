import { describe, expect, it } from 'vitest'
import { GITHUB_RELEASES_URL, GITHUB_REPO } from './updater.js'

describe('updater target', () => {
  it('uses the XiaoShiLiu release repository', () => {
    expect(GITHUB_REPO).toBe('weijinoend/xiaoshiliu')
    expect(GITHUB_RELEASES_URL).toBe('https://github.com/weijinoend/xiaoshiliu/releases')
  })
})
