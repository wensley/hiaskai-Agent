import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import {
  createModelUid,
  customSelection,
  isCustomSelection,
  normalizeCustomModel,
  readCustomModels,
  saveCustomModels,
  selectionUid,
  type CustomModel,
} from './api/providers.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { defaultSystemPrompt } from './systemPrompt.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  /** 当前模型；远端拉取的模型 id 直接存放，自定义模型为 custom:<uid> */
  model: string
  /** 用户自己添加的模型（第三方或中转站），存 localStorage */
  customModels: CustomModel[]
  thinking: boolean
  /** 思考强度 0-4，0 为关闭；与 thinking 保持同步 */
  reasoningEffort: number
  search: boolean
  siderCollapsed: boolean
  /** 是否启用工具调用（关闭后退化为纯聊天） */
  agentEnabled: boolean
  /** 危险操作审批：ask 弹窗确认，auto 直接执行（完全访问，无需确认） */
  toolApproval: 'ask' | 'auto'
  /** 单轮对话内最多的工具调用轮次，防止死循环 */
  maxToolRounds: number
  /** 是否启用最大步数限制；关闭后模型可以一直调用工具 */
  maxStepsEnabled: boolean
  /** 采样温度，null 表示不下发、用服务端默认值 */
  temperature: number | null
  /** 核采样 top_p，null 表示不下发、用服务端默认值 */
  topP: number | null
  /** 系统提示词：设置里可改，请求与子 Agent 共用；null 表示用默认 */
  systemPrompt: string | null
  /** 演示模式：使用本地脚本化模型，便于无 Key 体验工具链路 */
  mockAgent: boolean
  /** 动画特效强度：full 完整，reduced 仅保留必要过渡 */
  motion: 'full' | 'reduced'
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  model: 'chat-agent:model',
  thinking: 'chat-demo:thinking',
  reasoningEffort: 'chat-agent:reasoning-effort',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  agentEnabled: 'chat-agent:agent-enabled',
  toolApproval: 'chat-agent:tool-approval',
  maxToolRounds: 'chat-agent:max-tool-rounds',
  maxStepsEnabled: 'chat-agent:max-steps-enabled',
  temperature: 'chat-agent:temperature',
  topP: 'chat-agent:top-p',
  mockAgent: 'chat-agent:mock-agent',
  systemPrompt: 'chat-agent:system-prompt',
  motion: 'chat-agent:motion',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 默认模型，与实际服务的模型 id 一致 */
export const DEFAULT_MODEL = 'deepseek-flash'

/** 1-4 档对应的协议字段值，0 档不下发 */
const REASONING_EFFORT = ['low', 'medium', 'high', 'max'] as const

export const reasoningEffortValue = (effort: number) =>
  REASONING_EFFORT[Math.min(REASONING_EFFORT.length, Math.max(1, effort)) - 1]

/** Anthropic 兼容接口的思考预算，按档位递增 */
const THINKING_BUDGET = [0, 1024, 4096, 12000, 32000] as const

/** 服务端要求思考预算至少 1024，0 档也按下限兜底（正常路径不会用到） */
export const thinkingBudget = (effort: number) =>
  THINKING_BUDGET[Math.min(THINKING_BUDGET.length - 1, Math.max(1, effort))]

/** 思考强度分级：0 关闭，4 极致；标签与消耗提示由界面层翻译 */
export const EFFORT_LEVELS = 4

const initialModel = (): string => {
  const saved = read(KEYS.model)?.trim()
  if (!saved) {
    return DEFAULT_MODEL
  }
  // 自定义模型被删掉后选择器会留下死链，启动时收敛回默认模型
  if (isCustomSelection(saved)) {
    const uid = selectionUid(saved)
    return readCustomModels().some((item) => item.uid === uid) ? saved : DEFAULT_MODEL
  }
  return saved
}

const initialEffort = (): number => {
  const raw = Number(read(KEYS.reasoningEffort))
  if (Number.isFinite(raw)) {
    return Math.min(EFFORT_LEVELS, Math.max(0, Math.round(raw)))
  }
  return read(KEYS.thinking) === 'true' ? 2 : 0
}

/** 采样参数：没存过或存的值越界都当作「用默认」，即 null */
const readOptional = (key: string, min: number, max: number): number | null => {
  const raw = read(key)
  if (raw === null || raw.trim() === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= min && value <= max ? value : null
}

export const MIN_TEMPERATURE = 0
export const MAX_TEMPERATURE = 2
export const MIN_TOP_P = 0
export const MAX_TOP_P = 1

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  model: initialModel(),
  customModels: readCustomModels(),
  thinking: initialEffort() > 0,
  reasoningEffort: initialEffort(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  // 默认开启工具能力，首次使用即可体验 agent
  agentEnabled: read(KEYS.agentEnabled) !== 'false',
  toolApproval: read(KEYS.toolApproval) === 'auto' ? 'auto' : 'ask',
  maxToolRounds: clampRounds(Number(read(KEYS.maxToolRounds) ?? 8)),
  maxStepsEnabled: read(KEYS.maxStepsEnabled) !== 'false',
  temperature: readOptional(KEYS.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE),
  topP: readOptional(KEYS.topP, MIN_TOP_P, MAX_TOP_P),
  mockAgent: read(KEYS.mockAgent) === 'true',
  systemPrompt: read(KEYS.systemPrompt) ?? defaultSystemPrompt(),
  motion: read(KEYS.motion) === 'reduced' ? 'reduced' : 'full',
}))

/** 轮次限制在 1-24，避免异常配置导致死循环或能力不足 */
export function clampRounds(value: number): number {
  if (!Number.isFinite(value)) {
    return 8
  }
  return Math.min(24, Math.max(1, Math.round(value)))
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setModel = (model: string) => {
  const value = model.trim() || DEFAULT_MODEL
  write(KEYS.model, value)
  useSettings.setState({ model: value })
}

/** 打开思考但强度仍为 0 时，落到「标准」档 */
export const setThinking = (thinking: boolean) => {
  const effort = thinking ? useSettings.getState().reasoningEffort || 2 : 0
  write(KEYS.thinking, String(thinking))
  write(KEYS.reasoningEffort, String(effort))
  useSettings.setState({ thinking, reasoningEffort: effort })
}

/** 拖动轨道：0 档即关闭思考，大于 0 自动点亮深度思考 */
export const setReasoningEffort = (value: number) => {
  const effort = Math.min(EFFORT_LEVELS, Math.max(0, Math.round(value)))
  write(KEYS.reasoningEffort, String(effort))
  write(KEYS.thinking, String(effort > 0))
  useSettings.setState({ reasoningEffort: effort, thinking: effort > 0 })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setAgentEnabled = (agentEnabled: boolean) => {
  write(KEYS.agentEnabled, String(agentEnabled))
  useSettings.setState({ agentEnabled })
}

export const setToolApproval = (toolApproval: Settings['toolApproval']) => {
  write(KEYS.toolApproval, toolApproval)
  useSettings.setState({ toolApproval })
}

export const setMaxToolRounds = (rounds: number) => {
  const maxToolRounds = clampRounds(rounds)
  write(KEYS.maxToolRounds, String(maxToolRounds))
  useSettings.setState({ maxToolRounds })
}

export const setMaxStepsEnabled = (maxStepsEnabled: boolean) => {
  write(KEYS.maxStepsEnabled, String(maxStepsEnabled))
  useSettings.setState({ maxStepsEnabled })
}

/** 传 null 表示回到服务端默认值，同时清掉本地记录 */
export const setTemperature = (value: number | null) => {
  const temperature =
    value === null
      ? null
      : Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, Math.round(value * 100) / 100))
  write(KEYS.temperature, temperature === null ? null : String(temperature))
  useSettings.setState({ temperature })
}

export const setTopP = (value: number | null) => {
  const topP =
    value === null ? null : Math.min(MAX_TOP_P, Math.max(MIN_TOP_P, Math.round(value * 100) / 100))
  write(KEYS.topP, topP === null ? null : String(topP))
  useSettings.setState({ topP })
}

/** 传 null 表示恢复默认；空白串也按默认处理，避免请求里 system 为空 */
export const setSystemPrompt = (systemPrompt: string | null) => {
  const value = systemPrompt && systemPrompt.trim() ? systemPrompt : null
  write(KEYS.systemPrompt, value)
  useSettings.setState({ systemPrompt: value })
}

export const setMockAgent = (mockAgent: boolean) => {
  write(KEYS.mockAgent, String(mockAgent))
  useSettings.setState({ mockAgent })
}

export const setMotion = (motion: Settings['motion']) => {
  write(KEYS.motion, motion)
  useSettings.setState({ motion })
}

/** 新增自定义模型时由调用方提供，uid 与创建时间在这里补齐 */
export type CustomModelInput = Omit<CustomModel, 'uid' | 'createdAt'>

const persistCustomModels = (models: CustomModel[]) => {
  saveCustomModels(models)
  useSettings.setState({ customModels: models })
}

/** 保存自定义模型：同 uid 覆盖，否则追加，返回落库后的条目 */
export const addCustomModel = (input: CustomModelInput): CustomModel | null => {
  const model = normalizeCustomModel({
    ...input,
    uid: createModelUid(),
    createdAt: Date.now(),
  })
  if (!model) {
    return null
  }
  persistCustomModels([...useSettings.getState().customModels, model])
  return model
}

/** 修改已有条目；改出非法结构时保持原样，返回是否生效 */
export const updateCustomModel = (uid: string, patch: Partial<CustomModelInput>): boolean => {
  const current = useSettings.getState().customModels
  const index = current.findIndex((item) => item.uid === uid)
  if (index < 0) {
    return false
  }
  const next = normalizeCustomModel({ ...current[index], ...patch, uid })
  if (!next) {
    return false
  }
  const models = [...current]
  models[index] = next
  persistCustomModels(models)
  return true
}

/** 删除后把指向它的选择收敛回默认模型，避免请求打到不存在的配置上 */
export const removeCustomModel = (uid: string) => {
  const models = useSettings.getState().customModels.filter((item) => item.uid !== uid)
  persistCustomModels(models)
  if (useSettings.getState().model === customSelection(uid)) {
    setModel(DEFAULT_MODEL)
  }
}
