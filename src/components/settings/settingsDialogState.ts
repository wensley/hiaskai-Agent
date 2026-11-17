import { create } from 'zustand'
import { resolveModelTarget } from '../../services/api/providers.js'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 自定义模型 / Agent 运行时 / 数据管理 */
export type SettingsSection = 'general' | 'models' | 'agent' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 当前选择的模型是否已有可用凭据：内置 Key，或自定义模型自带的 Key */
const hasUsableKey = () => {
  const { apiKey, model, customModels } = useSettings.getState()
  if (apiKey) {
    return true
  }
  return Boolean(resolveModelTarget(model, apiKey, customModels).apiKey)
}

/** 没有可用凭据时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  // 演示模式走本地脚本化模型，不需要 Key 也能体验完整链路
  if (useSettings.getState().mockAgent || hasUsableKey()) {
    return true
  }
  openSettings('data')
  return false
}

/** 附件走 DeepSeek Files API，自定义模型的 Key 不能用来上传，仍然要求内置 Key */
export const ensureUploadKey = () => {
  const { apiKey, mockAgent } = useSettings.getState()
  if (apiKey || mockAgent) {
    return true
  }
  openSettings('data')
  return false
}
