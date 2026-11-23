import { ApiError } from './apiError.js'
import { chatCompletionsUrl, type ModelTarget } from './providers.js'
import { readServerSentEvents } from './sse.js'
import type {
  ClientToolDefinition,
  CreateMessageRequest,
  MessageStreamEvent,
  MessageUsage,
  RequestTool,
  StopReason,
  ToolResultBlockParam,
} from './types.js'

/**
 * OpenAI 兼容协议的请求/响应适配。
 * 应用内部只认 Anthropic 形态的流式事件，这里负责双向翻译，
 * 让工具循环、思考块、用量统计在第三方模型上照常工作。
 */

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAITool = {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

type OpenAIChunk = {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
  error?: { message?: string; type?: string }
}

const isClientTool = (tool: RequestTool): tool is ClientToolDefinition =>
  'input_schema' in tool && typeof (tool as ClientToolDefinition).name === 'string'

const toolResultText = (block: ToolResultBlockParam) =>
  typeof block.content === 'string'
    ? block.content
    : block.content.map((part) => part.text).join('\n')

/**
 * Anthropic 形态的消息 → OpenAI 的 messages。
 * tool_result 必须紧跟带 tool_calls 的 assistant 消息，因此按出现顺序即时展开。
 * latest_reminder 是 DeepSeek 的扩展角色，第三方模型没有，合并进 system。
 */
export const toOpenAIMessages = (body: CreateMessageRequest): OpenAIMessage[] => {
  const messages: OpenAIMessage[] = []
  const reminders: string[] = []
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      reminders.push(message.content)
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content) {
          messages.push({ role: 'user', content: message.content })
        }
        continue
      }
      const texts: string[] = []
      const images: string[] = []
      let dropped = false
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block) || '（无内容）',
          })
        } else if (block.type === 'text') {
          texts.push(block.text)
        } else if (block.type === 'image' && block.source.type === 'base64') {
          // 自定义模型没有 Files API：本地图片以 data URL 内联
          images.push(`data:${block.source.media_type};base64,${block.source.data}`)
        } else {
          dropped = true
        }
      }
      const text = texts.join('\n\n').trim()
      if (images.length > 0) {
        messages.push({
          role: 'user',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        })
      } else if (text) {
        messages.push({ role: 'user', content: text })
      } else if (dropped) {
        messages.push({ role: 'user', content: '（附件内容无法传给该模型，请改用文字描述）' })
      }
      continue
    }
    const texts: string[] = []
    const calls: OpenAIToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        texts.push(block.text)
      } else if (block.type === 'tool_use') {
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        })
      }
      // 思考块与服务端联网块不回传：第三方模型既不认识签名，也无从校验
    }
    const text = texts.join('\n\n').trim()
    if (text || calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      })
    }
  }
  const system = [body.system?.trim(), reminders.join('\n\n')].filter(Boolean).join('\n\n')
  return system ? [{ role: 'system', content: system }, ...messages] : messages
}

/** 只把客户端工具翻成 function 声明；deepseek_* 这类服务端工具第三方不认识 */
export const toOpenAITools = (tools: RequestTool[]): OpenAITool[] =>
  tools.filter(isClientTool).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))

/** OpenAI 只认 low / medium / high，DeepSeek 的 max 档映射到 high */
const openAIEffort = (effort: string) =>
  effort === 'max' ? 'high' : effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'medium'

export type OpenAIBodyOptions = {
  includeStreamOptions?: boolean
  includeTools?: boolean
}

export const buildOpenAIRequest = (
  target: ModelTarget,
  body: CreateMessageRequest,
  options: OpenAIBodyOptions = {}
) => {
  const tools = options.includeTools === false || !target.tools ? [] : toOpenAITools(body.tools ?? [])
  return {
    model: target.model,
    messages: toOpenAIMessages(body),
    stream: true,
    ...(options.includeStreamOptions === false ? {} : { stream_options: { include_usage: true } }),
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(target.reasoning && body.reasoning_effort
      ? { reasoning_effort: openAIEffort(body.reasoning_effort) }
      : {}),
  }
}

const readError = async (response: Response): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || response.statusText
  try {
    const parsed: unknown = JSON.parse(text)
    const error = (parsed as { error?: { message?: unknown } })?.error
    if (error && typeof error.message === 'string') {
      message = error.message
    }
  } catch {
    // 非 JSON 错误体直接展示原文
  }
  // 流已经开始却返回错误体：按流内错误处理，保留已有内容
  return new ApiError(response.status >= 400 ? 'http' : 'protocol', message, response.status)
}

const post = async (target: ModelTarget, payload: unknown, signal: AbortSignal) => {
  try {
    return await fetch(chatCompletionsUrl(target.baseUrl), {
      method: 'POST',
      headers: {
        // 留空 Key 的场景（本机网关、站点统一中转）不带鉴权头，由服务端自己处理
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
}

const mapUsage = (usage: NonNullable<OpenAIChunk['usage']>): MessageUsage => {
  const prompt = usage.prompt_tokens ?? 0
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  return {
    input_tokens: Math.max(0, prompt - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: usage.completion_tokens ?? 0,
  }
}

const mapFinish = (reason: string): StopReason => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  return 'end_turn'
}

/** 逐个产出的流式事件；块索引按出现顺序分配，文本、思考、工具各自成块 */
export async function* streamOpenAI(
  target: ModelTarget,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let response = await post(target, buildOpenAIRequest(target, body), signal)
  if (!response.ok) {
    const error = await readError(response)
    // 部分实现不认识 stream_options，去掉后重试一次，至少要能聊天
    if (error.status === 400 && /stream_options|include_usage/i.test(error.message)) {
      response = await post(
        target,
        buildOpenAIRequest(target, body, { includeStreamOptions: false }),
        signal
      )
      if (!response.ok) {
        throw await readError(response)
      }
    } else {
      throw error
    }
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readError(response)
  }

  const messageId = `oai_${Date.now()}`
  yield { type: 'message_start', message: { id: messageId, model: target.model } }

  let nextIndex = 0
  let textIndex = -1
  let thinkingIndex = -1
  const tools = new Map<number, { index: number; id: string; name: string; started: boolean }>()
  let stopReason: StopReason | null = null
  let usage: MessageUsage | undefined
  let chunks = 0

  /** 文本与思考互斥：换块前把上一块收口 */
  const events: MessageStreamEvent[] = []
  const close = (index: number) => {
    if (index >= 0) {
      events.push({ type: 'content_block_stop', index })
    }
  }
  const closeText = () => {
    close(textIndex)
    textIndex = -1
  }
  const closeThinking = () => {
    close(thinkingIndex)
    thinkingIndex = -1
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let chunk: OpenAIChunk
    try {
      chunk = JSON.parse(data) as OpenAIChunk
    } catch {
      continue
    }
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message ?? 'stream error')
    }
    chunks += 1
    if (chunk.usage) {
      usage = mapUsage(chunk.usage)
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    const delta = choice.delta ?? {}
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoning) {
      closeText()
      if (thinkingIndex < 0) {
        thinkingIndex = nextIndex++
        events.push({
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        })
      }
      events.push({
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })
    }
    if (typeof delta.content === 'string' && delta.content) {
      closeThinking()
      if (textIndex < 0) {
        textIndex = nextIndex++
        events.push({
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      events.push({
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      })
    }
    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0
      let entry = tools.get(key)
      if (!entry) {
        entry = { index: nextIndex++, id: call.id ?? `call_${key}`, name: '', started: false }
        tools.set(key, entry)
      }
      if (call.id) {
        entry.id = call.id
      }
      const name = call.function?.name
      if (name && !entry.started) {
        entry.name = name
      }
      const args = call.function?.arguments
      if (!entry.started && (entry.name || args)) {
        closeText()
        closeThinking()
        entry.started = true
        events.push({
          type: 'content_block_start',
          index: entry.index,
          content_block: {
            type: 'tool_use',
            id: entry.id,
            // 少数实现把 name 拆到后续分片，块已开出后无法改名，用占位符兜底
            name: entry.name || 'unknown_tool',
            input: {},
          },
        })
      }
      if (args) {
        events.push({
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'input_json_delta', partial_json: args },
        })
      }
    }
    if (choice.finish_reason) {
      stopReason = mapFinish(choice.finish_reason)
    }
    if (events.length > 0) {
      yield* events
      events.length = 0
    }
  }

  if (chunks === 0) {
    throw new ApiError('protocol', '服务商没有返回任何内容，请检查模型 ID 与接口地址')
  }
  closeThinking()
  closeText()
  for (const entry of tools.values()) {
    if (entry.started) {
      close(entry.index)
    }
  }
  if (events.length > 0) {
    yield* events
    events.length = 0
  }
  // 有工具调用就以 tool_use 收尾，部分服务商此时仍报 stop
  if ([...tools.values()].some((entry) => entry.started)) {
    stopReason = 'tool_use'
  }
  // OpenAI 兼容接口只在流末尾给用量：补一条 message_start 把本轮输入计入统计与上下文占用，
  // 否则状态条会一直显示「输入 0 tok」，右下角占用圆环也不会动
  if (usage) {
    yield { type: 'message_start', message: { id: messageId, model: target.model, usage } }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}
