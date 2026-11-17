import clsx from 'clsx'
import { useEffect, useReducer } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { modelLabel } from '../../services/api/models.js'
import { readLiveMetrics, subscribeLiveTick, useLiveStats } from '../../services/chat/liveStats.js'
import { useSettings } from '../../services/settings.js'
import styles from './LiveStatsBar.module.css'

const formatTokens = (value: number): string => {
  if (value >= 100000) {
    return `${Math.round(value / 1000)}k`
  }
  if (value >= 10000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}k`
  }
  return String(value)
}

const formatFirstToken = (ms: number | null): string => {
  if (ms === null) {
    return '—'
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

const formatCache = (rate: number | null): string =>
  rate === null ? '—' : `${(rate * 100).toFixed(1)}%`

const formatSpeed = (tps: number): string => (tps > 0 ? tps.toFixed(1) : '—')

const formatElapsed = (ms: number): string =>
  ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`

/** 数值变化时重挂载，触发一次「模糊上跳」动画 */
const Roll = ({ text }: { text: string }) => (
  <span key={text} className={styles.value}>
    {text}
  </span>
)

const Stat = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <span className={styles.stat}>
    <span className={styles.label}>{label}</span>
    <Roll text={value} />
    {unit ? <span className={styles.unit}>{unit}</span> : null}
  </span>
)

/**
 * 输入框底部的实时状态条：每秒刷新一次耗时与速度。
 * 服务端用量到达前用字符估算输出 token，缓存命中率按本轮输入总量计算。
 */
export const LiveStatsBar = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const run = useLiveStats((state) => state.run)
  const selectedModel = useSettings((state) => state.model)
  const active = run?.active ?? false
  const [, tick] = useReducer((value: number) => value + 1, 0)

  useEffect(() => subscribeLiveTick(active, tick), [active])

  // 只展示当前会话的运行数据，切换到别的会话时不串台
  const current = run && (sessionId === null || run.sessionId === sessionId) ? run : null
  const metrics = current ? readLiveMetrics(current) : null
  const model = current?.model ?? selectedModel

  return (
    <div className={styles.bar} data-active={active || undefined}>
      <span className={styles.status}>
        <span className={styles.dot} aria-hidden="true" />
        {active ? t('liveRunning') : t('liveReady')}
      </span>
      <span className={styles.model} title={model}>
        {modelLabel(model)}
      </span>
      <span className={styles.sep} aria-hidden="true" />
      {metrics ? (
        <>
          <Stat label={t('liveInput')} value={formatTokens(metrics.inputTokens)} unit="tok" />
          <Stat label={t('liveOutput')} value={formatTokens(metrics.outputTokens)} unit="tok" />
          <Stat label={t('liveFirstToken')} value={formatFirstToken(metrics.firstTokenMs)} />
          {/* 手机上放不下六项：缓存与瞬时速度优先让位，其余指标必须一屏看完 */}
          <span className={styles.optional}>
            <Stat label={t('liveCache')} value={formatCache(metrics.cacheRate)} />
            <Stat label={t('liveSpeed')} value={formatSpeed(metrics.tps)} unit="tok/s" />
          </span>
          <Stat label={t('liveElapsed')} value={formatElapsed(metrics.elapsed)} />
          {current && current.rounds > 1 ? (
            <span className={clsx(styles.stat, styles.rounds)}>
              <span className={styles.label}>×{current.rounds}</span>
            </span>
          ) : null}
        </>
      ) : (
        <span className={styles.empty}>{t('liveWaiting')}</span>
      )}
      <span className={styles.sweep} aria-hidden="true" />
    </div>
  )
}
