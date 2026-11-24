import { ApiError, request } from './client.js'
import { joinApiPath, parseCustomHeaders } from './origin.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage } from './types.js'

const toUsageInt = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0

const parseOpenAIUsage = (raw: unknown): MessageUsage | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const obj = raw as Record<string, unknown>
  const prompt = toUsageInt(obj.prompt_tokens ?? obj.input_tokens)
  const output = toUsageInt(obj.completion_tokens ?? obj.output_tokens)
  const promptDetails =
    typeof obj.prompt_tokens_details === 'object' && obj.prompt_tokens_details !== null
      ? (obj.prompt_tokens_details as Record<string, unknown>)
      : typeof obj.input_tokens_details === 'object' && obj.input_tokens_details !== null
        ? (obj.input_tokens_details as Record<string, unknown>)
        : undefined
  const cached = toUsageInt(promptDetails?.cached_tokens ?? obj.prompt_cache_hit_tokens)
  const input = Math.max(0, prompt - cached)
  if (prompt === 0 && output === 0) {
    return undefined
  }
  return {
    input_tokens: input,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: output,
  }
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIContentPart[]
}

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read blob'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })

const buildAuthHeaders = (apiKey: string, customHeadersRaw = ''): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...parseCustomHeaders(customHeadersRaw),
  ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
})

const toOpenAIMessages = (
  body: CreateMessageRequest,
  inlineImages: ReadonlyMap<string, string>,
  inlineTexts: ReadonlyMap<string, string>
): OpenAIMessage[] => {
  const result: OpenAIMessage[] = []
  if (body.system?.trim()) {
    result.push({ role: 'system', content: body.system.trim() })
  }
  let pendingReminder = ''
  for (const msg of body.messages) {
    if (msg.role === 'latest_reminder') {
      pendingReminder = msg.content
      continue
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        const text = pendingReminder
          ? `[上下文信息：${pendingReminder}]\n${msg.content}`
          : msg.content
        pendingReminder = ''
        result.push({ role: 'user', content: text })
      } else {
        const parts: OpenAIContentPart[] = []
        if (pendingReminder) {
          parts.push({ type: 'text', text: `[上下文信息：${pendingReminder}]` })
          pendingReminder = ''
        }
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            const url = inlineImages.get(block.source.file_id)
            if (url) {
              parts.push({ type: 'image_url', image_url: { url } })
            }
          } else if (block.type === 'document') {
            const docText = inlineTexts.get(block.source.file_id)
            if (docText) {
              parts.push({ type: 'text', text: docText })
            }
          }
        }
        result.push({
          role: 'user',
          content: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
        })
      }
      continue
    }
    const text = msg.content
      .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
      .join('\n\n')
    if (text) {
      result.push({ role: 'assistant', content: text })
    }
  }
  return result
}

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string }

type ResponsesInputItem = {
  role: 'user' | 'assistant'
  content: ResponsesInputPart[]
}

const toResponsesInput = (
  body: CreateMessageRequest,
  inlineImages: ReadonlyMap<string, string>,
  inlineTexts: ReadonlyMap<string, string>
): ResponsesInputItem[] => {
  const result: ResponsesInputItem[] = []
  let pendingReminder = ''
  for (const msg of body.messages) {
    if (msg.role === 'latest_reminder') {
      pendingReminder = msg.content
      continue
    }
    if (msg.role === 'user') {
      const parts: ResponsesInputPart[] = []
      if (pendingReminder) {
        parts.push({ type: 'input_text', text: `[上下文信息：${pendingReminder}]` })
        pendingReminder = ''
      }
      if (typeof msg.content === 'string') {
        parts.push({ type: 'input_text', text: msg.content })
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text })
          } else if (block.type === 'image') {
            const url = inlineImages.get(block.source.file_id)
            if (url) {
              parts.push({ type: 'input_image', image_url: url })
            }
          } else if (block.type === 'document') {
            const docText = inlineTexts.get(block.source.file_id)
            if (docText) {
              parts.push({ type: 'input_text', text: docText })
            }
          }
        }
      }
      result.push({
        role: 'user',
        content: parts.length > 0 ? parts : [{ type: 'input_text', text: '' }],
      })
      continue
    }
    const text = msg.content
      .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
      .join('\n\n')
    if (text) {
      result.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
    }
  }
  return result
}

const mapFinishReason = (reason: unknown): 'end_turn' | 'max_tokens' | 'refusal' => {
  if (reason === 'length' || reason === 'max_output_tokens') {
    return 'max_tokens'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  return 'end_turn'
}

/**
 * 调用 OpenAI 兼容 /v1/chat/completions 流式接口，并转换为统一 MessageStreamEvent。
 */
export type ReasoningEffort = 'low' | 'high' | 'max' | 'xhigh'

const mapReasoningEffort = (effort?: ReasoningEffort) => (effort === 'max' ? 'high' : effort)

export async function* streamOpenAIMessage(
  baseUrl: string,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  inlineImages: ReadonlyMap<string, string> = new Map(),
  inlineTexts: ReadonlyMap<string, string> = new Map(),
  customHeadersRaw = '',
  thinkingEffort?: ReasoningEffort
): AsyncGenerator<MessageStreamEvent> {
  const url = joinApiPath(baseUrl, '/chat/completions')
  const effort = mapReasoningEffort(thinkingEffort)
  const payload: Record<string, unknown> = {
    model: body.model,
    messages: toOpenAIMessages(body, inlineImages, inlineTexts),
    stream: true,
    stream_options: { include_usage: true },
    ...(body.thinking.type === 'enabled' && effort ? { reasoning_effort: effort } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
  }

  const response = await request(url, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(apiKey, customHeadersRaw),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.body) {
    throw new ApiError('protocol', '')
  }

  let started = false
  let thinkingIndex: number | null = null
  let textIndex: number | null = null
  let nextBlockIndex = 0
  let finishReason: 'end_turn' | 'max_tokens' | 'refusal' = 'end_turn'
  let usage: MessageUsage | undefined

  const ensureStart = function* () {
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: { id: `oai_${Date.now()}`, model: body.model },
      } satisfies MessageStreamEvent
    }
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed || trimmed === '[DONE]') {
      if (trimmed === '[DONE]') {
        break
      }
      continue
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof chunk !== 'object' || chunk === null) {
      continue
    }
    const obj = chunk as Record<string, unknown>
    if (
      typeof obj.error === 'object' &&
      obj.error !== null &&
      typeof (obj.error as Record<string, unknown>).message === 'string'
    ) {
      throw new ApiError('stream', (obj.error as Record<string, unknown>).message as string)
    }
    if (obj.usage !== undefined) {
      usage = parseOpenAIUsage(obj.usage) ?? usage
    }
    const choices = Array.isArray(obj.choices) ? obj.choices : []
    const choice = choices[0] as Record<string, unknown> | undefined
    if (!choice) {
      continue
    }
    if (typeof choice.finish_reason === 'string') {
      finishReason = mapFinishReason(choice.finish_reason)
    }
    const delta =
      typeof choice.delta === 'object' && choice.delta !== null
        ? (choice.delta as Record<string, unknown>)
        : undefined
    if (!delta) {
      continue
    }

    const reasoningDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoningDelta) {
      yield* ensureStart()
      if (thinkingIndex === null) {
        thinkingIndex = nextBlockIndex++
        yield {
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoningDelta },
      }
    }

    const textDelta = typeof delta.content === 'string' ? delta.content : ''
    if (textDelta) {
      yield* ensureStart()
      if (thinkingIndex !== null && textIndex === null) {
        yield { type: 'content_block_stop', index: thinkingIndex }
      }
      if (textIndex === null) {
        textIndex = nextBlockIndex++
        yield {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: textDelta },
      }
    }
  }

  yield* ensureStart()
  if (thinkingIndex !== null && textIndex === null) {
    yield { type: 'content_block_stop', index: thinkingIndex }
  }
  if (textIndex !== null) {
    yield { type: 'content_block_stop', index: textIndex }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}

/**
 * 调用 OpenAI Responses API (/v1/responses) 流式接口，并转换为统一 MessageStreamEvent。
 */
export async function* streamResponsesMessage(
  baseUrl: string,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  inlineImages: ReadonlyMap<string, string> = new Map(),
  inlineTexts: ReadonlyMap<string, string> = new Map(),
  customHeadersRaw = '',
  thinkingEffort?: ReasoningEffort
): AsyncGenerator<MessageStreamEvent> {
  const url = joinApiPath(baseUrl, '/responses')
  const effort = mapReasoningEffort(thinkingEffort)
  const payload: Record<string, unknown> = {
    model: body.model,
    ...(body.system?.trim() ? { instructions: body.system.trim() } : {}),
    input: toResponsesInput(body, inlineImages, inlineTexts),
    stream: true,
    store: false,
    ...(body.thinking.type === 'enabled' && effort ? { reasoning: { effort } } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.max_tokens !== undefined ? { max_output_tokens: body.max_tokens } : {}),
  }

  const response = await request(url, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(apiKey, customHeadersRaw),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.body) {
    throw new ApiError('protocol', '')
  }

  let started = false
  let thinkingIndex: number | null = null
  let textIndex: number | null = null
  let nextBlockIndex = 0
  let finishReason: 'end_turn' | 'max_tokens' | 'refusal' = 'end_turn'
  let usage: MessageUsage | undefined
  let receivedTextDelta = false

  const ensureStart = function* () {
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: { id: `resp_${Date.now()}`, model: body.model },
      } satisfies MessageStreamEvent
    }
  }

  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed || trimmed === '[DONE]') {
      if (trimmed === '[DONE]') {
        break
      }
      continue
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof chunk !== 'object' || chunk === null) {
      continue
    }
    const obj = chunk as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : eventName

    if (type === 'error' || type === 'response.failed') {
      const errObj =
        (obj.error as Record<string, unknown> | undefined) ??
        ((obj.response as Record<string, unknown> | undefined)?.error as
          | Record<string, unknown>
          | undefined)
      const msg = typeof errObj?.message === 'string' ? errObj.message : 'Responses API error'
      throw new ApiError('stream', msg)
    }

    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      const delta = typeof obj.delta === 'string' ? obj.delta : ''
      if (delta) {
        yield* ensureStart()
        if (thinkingIndex === null) {
          thinkingIndex = nextBlockIndex++
          yield {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: delta },
        }
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      const delta = typeof obj.delta === 'string' ? obj.delta : ''
      if (delta) {
        receivedTextDelta = true
        yield* ensureStart()
        if (thinkingIndex !== null && textIndex === null) {
          yield { type: 'content_block_stop', index: thinkingIndex }
        }
        if (textIndex === null) {
          textIndex = nextBlockIndex++
          yield {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: delta },
        }
      }
      continue
    }

    if (type === 'response.output_text.done' && !receivedTextDelta) {
      const full = typeof obj.text === 'string' ? obj.text : ''
      if (full) {
        yield* ensureStart()
        if (textIndex === null) {
          textIndex = nextBlockIndex++
          yield {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: full },
        }
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const respObj = obj.response as Record<string, unknown> | undefined
      usage = parseOpenAIUsage(respObj?.usage ?? obj.usage) ?? usage
    }

    if (type === 'response.incomplete') {
      const reason = (
        (obj.response as Record<string, unknown> | undefined)?.incomplete_details as
          | Record<string, unknown>
          | undefined
      )?.reason
      finishReason = mapFinishReason(reason)
    }
  }

  yield* ensureStart()
  if (thinkingIndex !== null && textIndex === null) {
    yield { type: 'content_block_stop', index: thinkingIndex }
  }
  if (textIndex !== null) {
    yield { type: 'content_block_stop', index: textIndex }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}

/** 使用自定义视觉 / OCR 模型（OpenAI Chat Completions 兼容）识别图片或文档内容 */
export const recognizeWithOpenAIVision = async ({
  baseUrl,
  apiKey,
  model,
  prompt,
  dataUrl,
  signal,
  customHeadersRaw = '',
}: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  dataUrl: string
  signal?: AbortSignal
  customHeadersRaw?: string
}): Promise<string> => {
  const url = joinApiPath(baseUrl, '/chat/completions')
  const response = await request(url, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey, customHeadersRaw),
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal,
  })
  const json: unknown = await response.json()
  if (typeof json !== 'object' || json === null) {
    return ''
  }
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return ''
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message
  if (typeof message?.content === 'string') {
    return message.content.trim()
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('')
      .trim()
  }
  return ''
}

export type GeneratedImageResult = {
  blob: Blob
  mimeType: string
  revisedPrompt?: string
}

const base64ToBlob = (b64: string, mimeType: string): Blob => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

const imageFromStringOrUrl = async (
  raw: string,
  revisedPrompt: string | undefined,
  signal?: AbortSignal
): Promise<GeneratedImageResult> => {
  if (raw.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(raw)
    if (match) {
      return { blob: base64ToBlob(match[2], match[1]), mimeType: match[1], revisedPrompt }
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    const imgResponse = await request(raw, { method: 'GET', signal })
    const blob = await imgResponse.blob()
    return {
      blob,
      mimeType: blob.type || 'image/png',
      revisedPrompt,
    }
  }
  const mimeType = 'image/png'
  return { blob: base64ToBlob(raw, mimeType), mimeType, revisedPrompt }
}

const extractImageFromResponsesPayload = async (
  payload: unknown,
  signal?: AbortSignal
): Promise<GeneratedImageResult | null> => {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const record = payload as Record<string, unknown>
  const output = Array.isArray(record.output) ? record.output : []
  for (const item of output) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const entry = item as Record<string, unknown>
    if (
      entry.type === 'image_generation_call' &&
      typeof entry.result === 'string' &&
      entry.result
    ) {
      const revised = typeof entry.revised_prompt === 'string' ? entry.revised_prompt : undefined
      return imageFromStringOrUrl(entry.result, revised, signal)
    }
    if (entry.type === 'message' && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (typeof part !== 'object' || part === null) {
          continue
        }
        const partObj = part as Record<string, unknown>
        if (typeof partObj.text === 'string') {
          const mdImg = /!\[[^\]]*\]\(([^)]+)\)/.exec(partObj.text)
          if (mdImg?.[1]) {
            return imageFromStringOrUrl(mdImg[1], undefined, signal)
          }
        }
      }
    }
  }
  return null
}

export type ReferenceImageInput = {
  blob: Blob
  name: string
  mimeType: string
}

const generateViaResponses = async ({
  baseUrl,
  apiKey,
  model,
  prompt,
  normalizedSize,
  customHeadersRaw,
  referenceImages,
  signal,
}: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  normalizedSize?: string
  customHeadersRaw: string
  referenceImages: ReferenceImageInput[]
  signal?: AbortSignal
}): Promise<GeneratedImageResult> => {
  const url = joinApiPath(baseUrl, '/responses')
  let input: unknown = prompt
  if (referenceImages.length > 0) {
    const parts: (
      | { type: 'input_text'; text: string }
      | { type: 'input_image'; image_url: string }
    )[] = [{ type: 'input_text', text: prompt }]
    for (const img of referenceImages) {
      parts.push({ type: 'input_image', image_url: await blobToDataUrl(img.blob) })
    }
    input = [{ role: 'user', content: parts }]
  }
  const response = await request(url, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey, customHeadersRaw),
    body: JSON.stringify({
      model,
      input,
      store: false,
      stream: true,
      tools: [
        {
          type: 'image_generation',
          ...(normalizedSize ? { size: normalizedSize } : {}),
        },
      ],
    }),
    signal,
  })
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  if (contentType.includes('text/event-stream') && response.body) {
    let lastPartial = ''
    let textAccum = ''
    for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
      const trimmed = data.trim()
      if (!trimmed || trimmed === '[DONE]') {
        continue
      }
      let chunk: unknown
      try {
        chunk = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (typeof chunk !== 'object' || chunk === null) {
        continue
      }
      const obj = chunk as Record<string, unknown>
      const type = typeof obj.type === 'string' ? obj.type : eventName
      if (type === 'error' || type === 'response.failed') {
        const errObj =
          (obj.error as Record<string, unknown> | undefined) ??
          ((obj.response as Record<string, unknown> | undefined)?.error as
            | Record<string, unknown>
            | undefined)
        throw new ApiError(
          'stream',
          typeof errObj?.message === 'string' ? errObj.message : 'Image generation failed'
        )
      }
      if (
        type === 'response.image_generation_call.partial_image' &&
        typeof obj.partial_image_b64 === 'string' &&
        obj.partial_image_b64
      ) {
        lastPartial = obj.partial_image_b64
      }
      if (type === 'response.output_text.delta' && typeof obj.delta === 'string') {
        textAccum += obj.delta
      }
      if (type === 'response.output_item.done') {
        const found = await extractImageFromResponsesPayload({ output: [obj.item] }, signal)
        if (found) {
          return found
        }
      }
      if (type === 'response.completed') {
        const found = await extractImageFromResponsesPayload(obj.response, signal)
        if (found) {
          return found
        }
      }
    }
    if (lastPartial) {
      return imageFromStringOrUrl(lastPartial, undefined, signal)
    }
    const mdImg = /!\[[^\]]*\]\(([^)]+)\)/.exec(textAccum)
    if (mdImg?.[1]) {
      return imageFromStringOrUrl(mdImg[1], undefined, signal)
    }
    throw new ApiError('protocol', 'No image returned from Responses API')
  }

  const json: unknown = await response.json()
  const extracted = await extractImageFromResponsesPayload(json, signal)
  if (extracted) {
    return extracted
  }
  throw new ApiError('protocol', 'No image returned from Responses API')
}

const generateViaImages = async ({
  baseUrl,
  apiKey,
  model,
  prompt,
  normalizedSize,
  customHeadersRaw,
  referenceImages,
  signal,
}: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  normalizedSize?: string
  customHeadersRaw: string
  referenceImages: ReferenceImageInput[]
  signal?: AbortSignal
}): Promise<GeneratedImageResult> => {
  let response: Response
  if (referenceImages.length > 0) {
    const url = joinApiPath(baseUrl, '/images/edits')
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    if (normalizedSize) {
      form.append('size', normalizedSize)
    }
    for (const img of referenceImages) {
      const fieldName = referenceImages.length > 1 ? 'image[]' : 'image'
      form.append(fieldName, img.blob, img.name || 'reference.png')
    }
    response = await request(url, {
      method: 'POST',
      headers: {
        ...parseCustomHeaders(customHeadersRaw),
        ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
      body: form,
      signal,
    })
  } else {
    const url = joinApiPath(baseUrl, '/images/generations')
    response = await request(url, {
      method: 'POST',
      headers: buildAuthHeaders(apiKey, customHeadersRaw),
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        ...(normalizedSize ? { size: normalizedSize } : {}),
      }),
      signal,
    })
  }
  const json: unknown = await response.json()
  if (typeof json !== 'object' || json === null) {
    throw new ApiError('protocol', 'Invalid image generation response')
  }
  const data = (json as { data?: unknown }).data
  const item = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined
  if (!item) {
    throw new ApiError('protocol', 'No image returned')
  }
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined

  if (typeof item.b64_json === 'string' && item.b64_json) {
    return imageFromStringOrUrl(item.b64_json, revisedPrompt, signal)
  }
  if (typeof item.url === 'string' && item.url) {
    return imageFromStringOrUrl(item.url, revisedPrompt, signal)
  }
  throw new ApiError('protocol', 'Unsupported image response format')
}

const shouldFallbackProtocol = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.kind === 'protocol' ||
    (error.kind === 'http' &&
      error.status !== undefined &&
      [400, 404, 405, 422, 501].includes(error.status)))

/**
 * 调用生图模型：
 * - protocol = 'auto'：自动匹配（支持 /v1/images/generations 与 /v1/responses 自动回退）
 * - protocol = 'images'：/v1/images/generations（图生图走 /v1/images/edits）
 * - protocol = 'responses'：/v1/responses + image_generation 工具
 */
export const generateImage = async ({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  protocol = 'auto',
  preferResponses = false,
  customHeadersRaw = '',
  referenceImages = [],
  signal,
}: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  size?: string
  protocol?: 'auto' | 'images' | 'responses'
  preferResponses?: boolean
  customHeadersRaw?: string
  referenceImages?: ReferenceImageInput[]
  signal?: AbortSignal
}): Promise<GeneratedImageResult> => {
  const normalizedSize =
    size && size.trim() && size.trim().toLowerCase() !== 'auto' ? size.trim() : undefined
  const params = {
    baseUrl,
    apiKey,
    model,
    prompt,
    normalizedSize,
    customHeadersRaw,
    referenceImages,
    signal,
  }
  if (protocol === 'responses') {
    return generateViaResponses(params)
  }
  if (protocol === 'images') {
    return generateViaImages(params)
  }
  const primary = preferResponses ? generateViaResponses : generateViaImages
  const fallback = preferResponses ? generateViaImages : generateViaResponses
  try {
    return await primary(params)
  } catch (error) {
    if (signal?.aborted || !shouldFallbackProtocol(error)) {
      throw error
    }
    return fallback(params)
  }
}
