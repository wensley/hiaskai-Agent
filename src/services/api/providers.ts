import { ANTHROPIC_BASE_URL } from './origin.js'

/** 自定义模型的接口协议：Anthropic 兼容走 /messages，OpenAI 兼容走 /chat/completions */
export type ProviderProtocol = 'anthropic' | 'openai'

/**
 * 用户自己添加的模型。所有字段都存 localStorage：
 * baseUrl 为接口根地址（不含 /messages 或 /chat/completions），apiKey 留空时回落到全局 Key。
 */
export type CustomModel = {
  /** 本地唯一标识，选择器里用 custom:<uid> 记录 */
  uid: string
  /** 选择器与状态条上显示的名称 */
  label: string
  /** 实际下发给服务商的 model 字段 */
  model: string
  baseUrl: string
  apiKey: string
  protocol: ProviderProtocol
  /** 上下文窗口，用于右下角占用圆环的折算 */
  contextWindow: number
  /** 是否声明客户端工具；部分服务商不支持 function calling，关掉后退化为纯聊天 */
  tools: boolean
  /** 是否下发思考强度；仅对支持 reasoning_effort / thinking 的模型打开 */
  reasoning: boolean
  createdAt: number
}

/** 自定义模型列表的存储键 */
export const CUSTOM_MODELS_KEY = 'chat-agent:custom-models'
/** 选择器里自定义模型的前缀，与远端模型 id 区分开 */
export const CUSTOM_PREFIX = 'custom:'
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const MIN_CONTEXT_WINDOW = 2_000
export const MAX_CONTEXT_WINDOW = 2_000_000

export const isCustomSelection = (selection: string) => selection.startsWith(CUSTOM_PREFIX)
export const customSelection = (uid: string) => `${CUSTOM_PREFIX}${uid}`
export const selectionUid = (selection: string) =>
  isCustomSelection(selection) ? selection.slice(CUSTOM_PREFIX.length) : ''

export const createModelUid = () =>
  `cm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 去掉首尾空白与结尾斜杠，避免拼出 //messages */
export const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '')

/** 接口根地址可能被填成完整端点，补齐时只认一次 */
export const messagesUrl = (baseUrl: string) => {
  const base = normalizeBaseUrl(baseUrl)
  return base.endsWith('/messages') ? base : `${base}/messages`
}

export const chatCompletionsUrl = (baseUrl: string) => {
  const base = normalizeBaseUrl(baseUrl)
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

export const modelsUrl = (baseUrl: string) => {
  const base = normalizeBaseUrl(baseUrl)
  return base.endsWith('/models') ? base : `${base}/models`
}

const clampWindow = (value: number) =>
  Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.round(value)))

const readString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** 把存储里的任意结构收敛成合法条目；缺少 model 或 baseUrl 的条目直接丢弃 */
export const normalizeCustomModel = (value: unknown): CustomModel | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const model = readString(record.model)
  const baseUrl = normalizeBaseUrl(readString(record.baseUrl))
  if (!model || !baseUrl) {
    return null
  }
  const protocol: ProviderProtocol = record.protocol === 'openai' ? 'openai' : 'anthropic'
  const window = Number(record.contextWindow)
  return {
    uid: readString(record.uid) || createModelUid(),
    label: readString(record.label) || model,
    model,
    baseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey.trim() : '',
    protocol,
    contextWindow: clampWindow(
      Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW
    ),
    tools: record.tools !== false,
    reasoning: record.reasoning === true,
    createdAt: Number(record.createdAt) || Date.now(),
  }
}

export const readCustomModels = (): CustomModel[] => {
  try {
    const raw = localStorage.getItem(CUSTOM_MODELS_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item) => {
      const model = normalizeCustomModel(item)
      return model ? [model] : []
    })
  } catch {
    return []
  }
}

export const saveCustomModels = (models: CustomModel[]) => {
  try {
    localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(models))
  } catch {
    // 隐私模式下写入失败，本次会话内仍然可用
  }
}

/** 一次请求真正要用的连接参数 */
export type ModelTarget = {
  /** 选择器里的键：内置/远端模型就是模型 id，自定义模型为 custom:<uid> */
  selection: string
  /** 展示名；内置模型由调用方按 id 自行格式化 */
  label: string
  /** 下发给服务商的 model 字段 */
  model: string
  protocol: ProviderProtocol
  /** Anthropic 协议填 /messages 的根地址，OpenAI 协议填 /chat/completions 的根地址 */
  baseUrl: string
  apiKey: string
  /** 内置 DeepSeek 接口：联网搜索、文件上传、自动标题等扩展能力可用 */
  builtin: boolean
  tools: boolean
  reasoning: boolean
  contextWindow: number
}

const builtinTarget = (selection: string, apiKey: string | null): ModelTarget => ({
  selection,
  label: selection,
  model: selection,
  protocol: 'anthropic',
  baseUrl: ANTHROPIC_BASE_URL,
  apiKey: apiKey ?? '',
  builtin: true,
  tools: true,
  reasoning: true,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
})

/**
 * 把设置里保存的选择解析成请求参数。
 * 自定义模型被删除后回落到内置默认 id，避免选择器里留下死链。
 */
export const resolveModelTarget = (
  selection: string,
  fallbackApiKey: string | null,
  models?: CustomModel[]
): ModelTarget => {
  if (!isCustomSelection(selection)) {
    return builtinTarget(selection, fallbackApiKey)
  }
  const uid = selectionUid(selection)
  const list = models ?? readCustomModels()
  const model = list.find((item) => item.uid === uid)
  if (!model) {
    return builtinTarget('deepseek-flash', fallbackApiKey)
  }
  return {
    selection,
    label: model.label,
    model: model.model,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey || (fallbackApiKey ?? ''),
    builtin: false,
    tools: model.tools,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }
}

/** 选择器条目：自定义模型单独一档，排在远端与内置之前 */
export type CustomModelOption = {
  /** 选择器里保存的值 */
  value: string
  label: string
  /** 副标题：模型 id 与地址，方便区分同名模型 */
  hint: string
}

export const customModelOptions = (models: CustomModel[]): CustomModelOption[] =>
  models.map((model) => ({
    value: customSelection(model.uid),
    label: model.label,
    hint: `${model.model} · ${model.baseUrl}`,
  }))

/** 跨域失败时抛出的哨兵值，界面据此换成「改成站点中转」的提示 */
export const CORS_HINT = 'cors-blocked'

/** 从 /models 拿到的条目：id 用来下发，label 用来展示 */
export type ProbeModel = { id: string; label: string }

/** 兼容 OpenAI 的 {data:[{id, display_name}]}、Anthropic 的 {data:[{id,name}]} 与纯字符串数组 */
const parseProbeModels = (list: unknown[]): { count: number; models: ProbeModel[] } => {
  const seen = new Set<string>()
  const models: ProbeModel[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (!seen.has(item)) {
        seen.add(item)
        models.push({ id: item, label: item })
      }
      continue
    }
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const entry = item as Record<string, unknown>
    const id =
      typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    const label =
      (typeof entry.display_name === 'string' && entry.display_name) ||
      (typeof entry.displayName === 'string' && entry.displayName) ||
      (typeof entry.name === 'string' && entry.name) ||
      id
    models.push({ id, label })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return { count: models.length, models }
}

/** 打通性测试：GET /models 只验证鉴权与地址，不产生推理费用 */
export const probeCustomModel = async (model: CustomModel, fallbackApiKey: string | null) => {
  // 站点统一中转或本机网关可能不需要 Key，这里不再强制
  const apiKey = model.apiKey || (fallbackApiKey ?? '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    let response: Response
    try {
      response = await fetch(modelsUrl(model.baseUrl), {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(model.protocol === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : {}),
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
    } catch (error) {
      // fetch 抛 TypeError 基本都是跨域被拦或地址不可达，交给界面给出可执行的提示
      if (error instanceof TypeError) {
        throw new Error(CORS_HINT)
      }
      throw error
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const payload: unknown = await response.json().catch(() => null)
    const list =
      typeof payload === 'object' && payload !== null
        ? ((payload as Record<string, unknown>).data ??
          (payload as Record<string, unknown>).models)
        : null
    return Array.isArray(list) ? parseProbeModels(list) : { count: 0, models: [] }
  } finally {
    clearTimeout(timer)
  }
}
