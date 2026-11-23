import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { ToolCallPart, ToolResultPart } from '../../services/chat/types.js'
import { describeToolInput } from '../../services/agent/runtime.js'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { AiStatus } from '../base/AiStatus.js'
import { toolIcon } from './ToolIcons.js'
import styles from './ToolCallCard.module.css'

const formatDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

const statusText = (
  status: ToolCallPart['status'],
  name: string,
  labels: { waiting: string; answered: string }
) => {
  if (name === 'ask_user') {
    if (status === 'running') {
      return labels.waiting
    }
    if (status === 'done') {
      return labels.answered
    }
  }
  switch (status) {
    case 'awaiting':
      return '等待确认'
    case 'running':
      return '执行中'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    case 'denied':
      return '已拒绝'
    default:
      return '准备中'
  }
}

const MAX_PREVIEW = 900

/** ask_user 的参数改投影到卡片上：问题 + 选项，比原始 JSON 好读 */
const readAsk = (input: unknown) => {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  const options = Array.isArray(record.options)
    ? record.options
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          const label = (item as Record<string, unknown> | null)?.label
          return typeof label === 'string' ? label : ''
        })
        .filter(Boolean)
    : []
  return {
    question: typeof record.question === 'string' ? record.question : '',
    options,
  }
}

/** 工具调用卡片：状态、参数、耗时、结果与产物 */
export const ToolCallCard = ({
  call,
  result,
  isLast,
}: {
  call: ToolCallPart
  result?: ToolResultPart
  isLast: boolean
}) => {
  const t = useTranslate()
  const isAskUser = call.name === 'ask_user'
  const ask = isAskUser ? readAsk(call.input) : null
  // 提问本身已经在输入框上方展开，卡片保持收起，避免同一段内容出现两次
  const [open, setOpen] = useState(
    !isAskUser && (call.status === 'running' || call.status === 'awaiting')
  )
  const [expanded, setExpanded] = useState(false)
  const touched = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)

  // 执行中自动展开，完成后稍等片刻收起，保持时间线干净；
  // 子 Agent 的结论是主要输出，完成后保持展开
  useEffect(() => {
    if (touched.current) {
      return
    }
    if (!isAskUser && (call.status === 'running' || call.status === 'awaiting')) {
      setOpen(true)
      return
    }
    if (call.name === 'spawn_subagent' && call.status === 'done') {
      setOpen(true)
      return
    }
    if (call.status === 'done' || call.status === 'error' || call.status === 'denied') {
      // 用户点开过就不再自动收起；touched 在定时器触发时再判断一次，
      // 否则「刚点开就被几秒前排好的定时器关掉」会让人以为点击没生效
      timerRef.current = window.setTimeout(() => {
        if (!touched.current) {
          setOpen(false)
        }
      }, 1400)
      return () => window.clearTimeout(timerRef.current)
    }
    return undefined
  }, [call.status, call.name, isAskUser])

  const toggle = () => {
    touched.current = true
    window.clearTimeout(timerRef.current)
    setOpen((value) => !value)
  }

  const label = call.label ?? call.name
  const duration = result?.durationMs ?? (call.endedAt ? call.endedAt - call.startedAt : undefined)
  const raw = result?.content ?? ''
  // ask_user 的结果是给模型的完整句子，界面上只留「选择 / 补充说明」两行
  const answerLines = raw
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- '))
    .join('\n')
  const content = ask && answerLines ? answerLines : raw
  const long = content.length > MAX_PREVIEW
  const input = call.input as Record<string, unknown> | undefined
  const hasInput = input && Object.keys(input).length > 0

  return (
    <div className={clsx(styles.wrap, !isLast && styles.withLine)} data-status={call.status}>
      <span className={styles.dot} aria-hidden>
        <span className={styles.dotInner} />
      </span>
      <div className={styles.card}>
        <button type="button" className={styles.head} onClick={toggle} aria-expanded={open}>
          <span className={styles.icon}>{toolIcon(call.name, call.source)}</span>
          <span className={styles.titles}>
            <span className={styles.label}>{label}</span>
            <span className={styles.arg}>{describeToolInput(call.input)}</span>
          </span>
          <span className={styles.status}>
            <span className={styles.pulse} aria-hidden />
            {statusText(call.status, call.name, {
              waiting: t('askUserWaiting'),
              answered: t('askUserAnswered'),
            })}
          </span>
          {duration !== undefined ? (
            <span className={styles.duration}>{formatDuration(duration)}</span>
          ) : null}
          <span className={styles.chevron}>
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </button>

        {open ? (
          <div className={styles.body}>
            {ask ? (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>{t('agentToolQuestion')}</span>
                <p className={styles.askQuestion}>{ask.question}</p>
                {ask.options.length > 0 ? (
                  <div className={styles.chips}>
                    {ask.options.map((option) => (
                      <span key={option} className={styles.chip}>
                        {option}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : hasInput ? (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>{t('agentToolArgs')}</span>
                <pre className={styles.code}>{JSON.stringify(call.input, null, 2)}</pre>
              </div>
            ) : null}
            {call.status === 'running' ? (
              <AiStatus
                state="analyzing"
                label={t('agentToolRunning', { name: label })}
                detail={call.progress}
                timer={false}
                className={styles.progress}
              />
            ) : null}
            {content ? (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>{t('agentToolResult')}</span>
                <pre className={clsx(styles.code, styles.result)}>
                  {expanded || !long ? content : `${content.slice(0, MAX_PREVIEW)}…`}
                </pre>
                {long ? (
                  <button
                    type="button"
                    className={styles.more}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? t('agentToolCollapse') : t('agentToolExpand')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {result?.artifacts?.length ? (
              // 卡片内只提示产物，完整卡片统一在消息尾部展示，避免重复
              <div className={styles.artifacts}>
                <span className={styles.sectionTitle}>{t('agentToolArtifacts')}</span>
                <span className={styles.artifactNames}>
                  {result.artifacts.map((artifact) => artifact.name).join('、')}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
