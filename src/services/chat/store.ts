import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import { isCustomSelection, resolveModelTarget } from '../api/providers.js'
import type { ChatModel, CreateMessageRequest, RequestTool } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { reasoningEffortValue, thinkingBudget, useSettings } from '../settings.js'
import { buildToolDeclarations, runToolCalls } from '../agent/runtime.js'
import { clearApprovals } from '../agent/approval.js'
import { clearUserPrompts } from '../agent/userPrompt.js'
import { mockStreamMessage } from '../agent/mock.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  beginLiveRun,
  finishLiveRun,
  noteDelta,
  noteUsage,
} from './liveStats.js'
import { noteContextUsage } from './contextUsage.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
  type InlineImages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): RequestTool[] => {
  const tools: RequestTool[] = [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/**
 * 本轮声明的工具：服务端联网能力 + 客户端工具。
 * 关闭 agent 时只保留服务端工具，退化为原有聊天体验。
 */
const requestTools = (
  search: boolean,
  agentEnabled: boolean,
  /** 自定义模型走第三方接口，deepseek_* 服务端工具它们不认识，不声明 */
  allowServerTools = true
): RequestTool[] => {
  const tools = allowServerTools ? serverTools(search) : []
  return agentEnabled ? [...tools, ...buildToolDeclarations()] : tools
}

/** 第三方接口不会回传标题，用首条提问截一段本地生成，避免会话列表全是未命名 */
const fallbackTitle = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) {
    return ''
  }
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: model || MODEL,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

/**
 * 导入一段分享来的对话：先落库再切过去。
 * 保存失败也留在内存里，用户仍能查看，下一次编辑会再存一遍。
 */
export const importSharedSession = async (session: Session): Promise<void> => {
  if (get().importingHistory) {
    return
  }
  set((state) => ({
    sessions: sortSessions([
      toSessionSummary(session),
      ...state.sessions.filter((item) => item.id !== session.id),
    ]),
    sessionCache: { ...state.sessionCache, [session.id]: session },
    activeId: session.id,
  }))
  touchSession(session.id)
  try {
    await db.saveSession(session)
  } catch (error) {
    db.reportStorageError('save session')(error)
  }
}

/** 不切换界面的详情读取：分享、导出这类动作需要完整消息，但不想打断当前会话 */
export const loadSessionDetail = (id: string): Promise<void> => ensureSessionLoaded(id)

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    void db.deleteSessionArtifacts(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(
    getDraft(targetSessionId),
    useUploads.getState().tasks,
    isCustomSelection(useSettings.getState().model)
  )
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/**
 * 以用户身份追加一条消息并立刻请求回答。
 * 后台任务完成后的「把结果发给 Agent」走这里：用户看得到自己发了什么，也能撤回。
 */
export const sendInjectedMessage = (sessionId: string, text: string) => {
  const content = text.trim()
  if (!content || get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const now = Date.now()
  const history = getVisibleMessages(session)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content,
    files: [],
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (current) => ({
    ...appendBranch(current, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search, model } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用当前选择的模型和开关。
    model: previous.model ?? model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/** 自定义模型没有 Files API：把本地图片读成 base64，随请求一起内联发出去 */
const collectInlineImages = async (files: FileAttachment[]): Promise<InlineImages | undefined> => {
  const images: InlineImages = new Map()
  for (const file of files) {
    if (!file.isImage) {
      continue
    }
    const blob = await db.loadFile(file.id)
    if (!blob) {
      continue
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    images.set(file.id, {
      mediaType: blob.type || file.mimeType || 'image/png',
      data: btoa(binary),
    })
  }
  return images.size > 0 ? images : undefined
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  /** 首个请求真正发出时才开始计时，附件上传时间不计入首字延迟 */
  let metricsStarted = false
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    const settings = useSettings.getState()
    /**
     * 本轮实际使用的接口：内置 DeepSeek 接口，或设置里自己添加的第三方模型。
     * 选择器保存的是选择键（自定义模型为 custom:<uid>），这里解析成请求参数。
     */
    const target = resolveModelTarget(
      initial.model ?? settings.model,
      settings.apiKey,
      settings.customModels
    )
    // 自定义模型不走 Files API：本轮图片先读成本地 base64，后续每轮复用
    const inlineImages = target.builtin
      ? undefined
      : await collectInlineImages(request.question.files)
    // 续写使用前缀，不能同时跑工具循环；关闭 agent 时退化为普通聊天。
    const agentEnabled = settings.agentEnabled && !request.prefix
    // 关掉「最大步数」后不设上限，交给用户自己盯；打开时按设置值收口
    const maxRounds = agentEnabled
      ? settings.maxStepsEnabled
        ? settings.maxToolRounds
        : Number.POSITIVE_INFINITY
      : 0
    /** 服务端不支持自定义工具时，去掉工具声明重试一次，至少保证对话可用 */
    let fallbackWithoutTools = false
    /** 服务端不认识思考强度字段时，退回只声明 enabled，保证对话可用 */
    let fallbackNoReasoning = false

    for (let round = 0; ; round += 1) {
      let hasPendingTools = false
      let roundErrored = false

      for (let attempt = 0; ; attempt += 1) {
        /** 附件补齐前出错属于上传失败，请求还没有发出 */
        let preparing = true
        let receivedContent = false
        try {
          // 附件通过 DeepSeek Files API 引用，第三方模型用不了，直接跳过补传
          const prepared = target.builtin
            ? await prepareFiles(sessionId, request, controller.signal)
            : { history: request.history, question: request.question, prefix: request.prefix }
          preparing = false
          // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
          const latestReminder = prepared.prefix
            ? prepared.prefix.latestReminder
            : createLatestReminder(useSettings.getState())
          reply = { ...reply, latestReminder }
          updateReply(sessionId, reply)
          persist(sessionId)
          const messages = toRequestMessages(
            prepared.history,
            prepared.question,
            prepared.prefix,
            initial.thinking ?? false,
            latestReminder,
            // 工具轮回：把本轮已产生的调用与结果接在提问之后
            round > 0 ? reply : undefined,
            // 自定义模型把本轮图片内联进请求，不需要 Files API
            inlineImages
          )
          // 自动标题是 DeepSeek 的扩展能力，第三方接口不会回传
          const withTitle = target.builtin && round === 0 && titleRequests.has(controller)
          const effort = initial.thinking ? useSettings.getState().reasoningEffort : 0
          const body: CreateMessageRequest = {
            model: target.model,
            system: SYSTEM_PROMPT,
            messages,
            thinking: initial.thinking
              ? fallbackNoReasoning
                ? { type: 'enabled' }
                : { type: 'enabled', budget_tokens: thinkingBudget(effort) }
              : { type: 'disabled' },
            // 真实下发思考强度：关闭思考时不带该字段
            ...(initial.thinking && effort > 0 && !fallbackNoReasoning
              ? { reasoning_effort: reasoningEffortValue(effort) }
              : {}),
            safety_check: SAFETY_CHECK,
            // 采样参数留空时不下发，走服务端默认值
            ...(settings.temperature !== null ? { temperature: settings.temperature } : {}),
            ...(settings.topP !== null ? { top_p: settings.topP } : {}),
            tools: requestTools(
              initial.search ?? false,
              agentEnabled && !fallbackWithoutTools && target.tools,
              target.builtin
            ),
            ...(withTitle ? { title: { enabled: true } } : {}),
          }
          if (!metricsStarted) {
            metricsStarted = true
            // 状态条按选择键显示模型名，自定义模型才能显示用户起的名字
            beginLiveRun(sessionId, target.selection)
          }
          const events = settings.mockAgent
            ? mockStreamMessage(body, controller.signal)
            : streamMessage(target, body, controller.signal)
          const blockIndexes = new Map<number, number>()
          for await (const event of events) {
            receivedContent ||= event.type === 'content_block_start'
            if (event.type === 'message_start') {
              noteUsage(event.message.usage, 'start')
              noteContextUsage(sessionId, event.message.usage)
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                noteDelta('text', event.delta.text)
              } else if (event.delta.type === 'thinking_delta') {
                noteDelta('thinking', event.delta.thinking)
              }
            } else if (event.type === 'message_delta') {
              noteUsage(event.usage, 'delta')
            }
            if (
              event.type === 'message_delta' &&
              (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
              event.delta.title?.trim() &&
              withTitle &&
              !controller.signal.aborted &&
              !get().importingHistory
            ) {
              const title = event.delta.title.trim()
              updateSession(sessionId, (session) =>
                session.title ? session : { ...session, title }
              )
              titleRequests.delete(controller)
            }
            reply = applyEvent(reply, event, Date.now(), blockIndexes)
            if (document.visibilityState === 'hidden') {
              flush()
            } else {
              frame ||= requestAnimationFrame(flush)
            }
          }
          reply = settleReply(reply, 'done', Date.now())
          // 第三方接口不会回传标题：首轮结束后用提问内容兜底，会话列表才不是一片未命名
          if (
            !target.builtin &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = fallbackTitle(request.question.content)
            if (title) {
              updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            }
            titleRequests.delete(controller)
          }
          hasPendingTools =
            agentEnabled &&
            !fallbackWithoutTools &&
            reply.stopReason === 'tool_use' &&
            reply.blocks.some((block) => block.type === 'tool_use' && block.status === 'pending')
          break
        } catch (error) {
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            roundErrored = true
            break
          }
          if (preparing) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'upload',
              message: '',
              localMessage: describeUploadError(error),
              retryable: isRetryableApiError(error),
            })
            roundErrored = true
            break
          }
          // 服务端不认识自定义工具（400）时，去掉工具声明重试，保留对话能力
          if (
            agentEnabled &&
            !fallbackWithoutTools &&
            !receivedContent &&
            error instanceof ApiError &&
            error.status === 400 &&
            /tool/i.test(error.message)
          ) {
            fallbackWithoutTools = true
            continue
          }
          // 服务端不认识 reasoning_effort / budget_tokens 时，降级为普通思考请求
          if (
            initial.thinking &&
            !fallbackNoReasoning &&
            !receivedContent &&
            error instanceof ApiError &&
            error.status === 400 &&
            /reasoning|thinking|budget|effort/i.test(error.message)
          ) {
            fallbackNoReasoning = true
            continue
          }
          // 附件失效：重新补传后重发。收到过内容块（含客户端工具）后不自动重发。
          if (
            attempt < FILE_RETRY_LIMIT &&
            !receivedContent &&
            reuploadInvalidatedFiles(sessionId, request, error)
          ) {
            await waitForRetry(attempt, controller.signal)
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              roundErrored = true
              break
            }
            continue
          }
          if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
            // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
            reply = settleReply(reply, 'done', Date.now())
          } else if (error instanceof ApiError) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: error.kind,
              message: error.message,
              status: error.status,
              localMessage: error.localMessage,
            })
          } else {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'protocol',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          roundErrored = true
          break
        }
      }

      if (!hasPendingTools || roundErrored || controller.signal.aborted) {
        break
      }

      // 执行本轮工具：顺序执行，结果写回同一条消息，下一轮请求带上 tool_result
      reply = await runToolCalls(reply, {
        sessionId,
        signal: controller.signal,
        update: (next) => {
          reply = next
          flush()
        },
      })
      persist(sessionId)
      if (controller.signal.aborted) {
        reply = settleReply(reply, 'stopped', Date.now())
        break
      }
      if (round >= maxRounds) {
        reply = {
          ...reply,
          blocks: [
            ...reply.blocks,
            {
              type: 'text',
              text: `\n\n> 已达到单轮 ${maxRounds} 次工具调用的上限，已停止继续调用。可以发送新消息继续。`,
            },
          ],
        }
        break
      }
    }
  } finally {
    finishLiveRun(sessionId)
    clearApprovals((item) => item.sessionId === sessionId)
    // 本轮结束（含中止）时撤掉还挂着的提问卡片，避免留下无人等待的输入
    clearUserPrompts((item) => item.sessionId === sessionId)
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
