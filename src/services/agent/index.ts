import { registerTools } from './registry.js'
import { browserTools } from './tools/browserTools.js'
import { widgetTools } from './tools/widgetTools.js'
import { agentTools } from './tools/agentTools.js'
import { askUserTools } from './tools/askUserTool.js'
import { workspaceTools } from './tools/workspaceTools.js'
import { utilityTools } from './tools/utilityTools.js'
import { initExtensionBridge } from './extension.js'
import { initDesktop } from './desktop/store.js'
import { connectEnabledServers } from './mcp/store.js'
import { useSettings } from '../settings.js'

let started = false

/** 把动效偏好写到根节点，CSS 据此关闭装饰性动画 */
const applyMotion = (motion: 'full' | 'reduced') => {
  document.documentElement.dataset.motion = motion
}

/**
 * 初始化 agent 能力：内置工具、扩展桥、桌面连接、MCP 服务器。
 * 全部失败也不影响聊天本身。
 */
export const initAgent = () => {
  if (started) {
    return
  }
  started = true
  // utilityTools：one_cedric 移植的纯浏览器工具（计算、编码、JSON/CSV、正则、二维码等），无需后端
  registerTools([
    ...browserTools,
    ...widgetTools,
    ...agentTools,
    ...askUserTools,
    ...workspaceTools,
    ...utilityTools,
  ])
  initExtensionBridge()
  initDesktop()
  void connectEnabledServers()
  applyMotion(useSettings.getState().motion)
  useSettings.subscribe((state, previous) => {
    if (state.motion !== previous.motion) {
      applyMotion(state.motion)
    }
  })
}
