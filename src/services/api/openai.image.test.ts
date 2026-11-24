import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateImage } from './openai.js'

const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

describe('generateImage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('requests multiple GIF results and keeps every returned image', async () => {
    const requestBodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(
          JSON.stringify({
            data: [{ b64_json: GIF_BASE64 }, { b64_json: GIF_BASE64 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )

    const results = await generateImage({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'gpt-image-2.6-flare',
      prompt: 'animated test',
      protocol: 'images',
      outputFormat: 'gif',
      count: 2,
      gifFrameCount: 4,
      gifFrameDurationMs: 120,
    })

    expect(results).toHaveLength(2)
    expect(results[0].mimeType).toBe('image/gif')
    expect(requestBodies[0]).toMatchObject({
      n: 2,
      output_format: 'gif',
      frame_count: 4,
      frame_duration_ms: 120,
    })
  })
})
