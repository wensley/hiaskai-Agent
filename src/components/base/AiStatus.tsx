import clsx from 'clsx'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from 'motion/react'
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import styles from './AiStatus.module.css'

/**
 * 行内 AI 状态：思考 / 检索 / 分析 / 写作 / 完成 / 失败六态。
 * 移植自 swamimalode07/rare-ui 的 ai-status，用 ResizeObserver 替掉 react-use-measure，
 * 去掉 Tailwind 与 cn()，颜色改用项目 token。
 */

export type AiStatusState = 'thinking' | 'researching' | 'analyzing' | 'writing' | 'done' | 'error'

export type AiStatusProps = ComponentProps<'div'> & {
  state?: AiStatusState
  /** 主文案；不传按状态取默认 */
  label?: string
  /** 次要说明，例如当前工具名 */
  detail?: string
  /** 是否显示计时 */
  timer?: boolean
  /** 外部给定耗时（秒），给了就不再自己计时 */
  elapsed?: number
  /** 覆盖是否跑流光 */
  shimmer?: boolean
}

const DEFAULT_LABELS: Record<AiStatusState, string> = {
  thinking: 'Thinking',
  researching: 'Researching',
  analyzing: 'Analyzing',
  writing: 'Writing',
  done: 'Done',
  error: 'Failed',
}

const ACTIVE_STATES = new Set<AiStatusState>(['thinking', 'researching', 'analyzing', 'writing'])

const PEN_PATH =
  'M3.78181 16.3092L3 21L7.69086 20.2182C8.50544 20.0825 9.25725 19.6956 9.84119 19.1116L20.4198 8.53288C21.1934 7.75922 21.1934 6.5049 20.4197 5.73126L18.2687 3.58024C17.495 2.80658 16.2406 2.80659 15.4669 3.58027L4.88841 14.159C4.30447 14.7429 3.91757 15.4947 3.78181 16.3092Z'
const SPARKLE_PATH = 'M11 5Q12 12 19 13Q12 14 11 21Q10 14 3 13Q10 12 11 5Z'
const WAVE_PATH = 'M3 19C4.11 16.3 5.06 16.3 6.17 19C7.27 21.7 8.22 21.7 9.33 19C10.44 16.3 11.39 16.3 12.5 19'
const WAVE_X = [3, 3.05, 3.18, 3.42, 3.78, 4.42, 5.26, 5.83, 6.29, 6.84, 7.76, 8.67, 9.22, 9.68, 10.25, 11.09, 11.72, 12.09, 12.33, 12.46, 12.5]
const WAVE_Y = [19, 18.88, 18.58, 18.1, 17.51, 17, 17.36, 18.25, 19.29, 20.33, 21.02, 20.32, 19.27, 18.24, 17.35, 17, 17.52, 18.11, 18.6, 18.9, 19]
const WAVE_PROGRESS = [0, 0.007, 0.028, 0.061, 0.104, 0.156, 0.216, 0.282, 0.352, 0.425, 0.5, 0.575, 0.648, 0.718, 0.784, 0.844, 0.896, 0.939, 0.972, 0.993, 1]
const DRAW_END = 0.7
const HOLD_END = 0.85
const SCRIBBLE: Transition = {
  duration: 2.4,
  ease: 'linear',
  repeat: Infinity,
  times: [...WAVE_PROGRESS.map((_, i) => (i / (WAVE_PROGRESS.length - 1)) * DRAW_END), HOLD_END, 1],
}
const TWINKLE_PATH = 'M18 2Q18.4 4.6 21 5Q18.4 5.4 18 8Q17.6 5.4 15 5Q17.6 4.6 18 2Z'

const SWAP: Transition = { type: 'spring', duration: 0.5, bounce: 0.15 }
const ICON: Transition = { type: 'spring', duration: 0.55, bounce: 0.35 }
const INSTANT: Transition = { duration: 0 }

const swapVariants: Variants = {
  enter: { y: 8, opacity: 0, filter: 'blur(4px)' },
  center: { y: 0, opacity: 1, filter: 'blur(0px)' },
  exit: { y: -8, opacity: 0, filter: 'blur(4px)' },
}

const iconVariants: Variants = {
  enter: { scale: 0.5, opacity: 0, rotate: -30, filter: 'blur(4px)' },
  center: { scale: 1, opacity: 1, rotate: 0, filter: 'blur(0px)' },
  exit: { scale: 0.5, opacity: 0, rotate: 30, filter: 'blur(4px)' },
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const LOOP = { repeat: Infinity, ease: 'easeInOut' } as const

const formatElapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`

/** 内容宽度：文案切换时整个胶囊用弹簧过渡，不会跳变 */
const useContentWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}

export const AiStatus = ({
  state = 'thinking',
  label,
  detail,
  timer = true,
  elapsed,
  shimmer,
  className,
  ...props
}: AiStatusProps) => {
  const reduced = !!useReducedMotion()
  const active = ACTIVE_STATES.has(state)
  const [counted, setCounted] = useState(0)
  const [wasActive, setWasActive] = useState(active)
  const [hasRun, setHasRun] = useState(active)
  const counting = timer && elapsed === undefined

  // 新一轮从 0 开始；在工作态之间切换则继续累计
  if (active !== wasActive) {
    setWasActive(active)
    if (active) {
      setCounted(0)
      setHasRun(true)
    }
  }

  useEffect(() => {
    if (!active || !counting) {
      return
    }
    const start = Date.now()
    const id = window.setInterval(() => setCounted(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [active, counting])

  const [measureRef, width] = useContentWidth()
  const swap = reduced ? INSTANT : SWAP
  const seconds = elapsed ?? (hasRun ? counted : undefined)
  const time = timer && seconds !== undefined ? formatElapsed(Math.max(0, Math.floor(seconds))) : undefined
  const text = label ?? DEFAULT_LABELS[state]
  const shimmering = shimmer ?? active

  return (
    <div
      data-slot="ai-status"
      data-state={state}
      data-active={active || undefined}
      role="status"
      className={clsx(styles.root, className)}
      {...props}
    >
      <span className={styles.iconWrap}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={state}
            aria-hidden
            variants={iconVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reduced ? INSTANT : ICON}
            className={styles.iconInner}
          >
            <AiStatusIcon state={state} />
          </motion.span>
        </AnimatePresence>
      </span>

      <motion.div
        className={styles.track}
        initial={false}
        animate={{ width: width || 'auto' }}
        transition={swap}
      >
        <div ref={measureRef} className={styles.content}>
          <span className={styles.labelGrid}>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={text}
                variants={swapVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={swap}
                data-slot="ai-status-label"
                className={clsx(styles.label, !shimmering && styles.labelIdle)}
              >
                {shimmering ? <Shimmer reduced={reduced}>{text}</Shimmer> : text}
              </motion.span>
            </AnimatePresence>
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            {detail ? (
              <motion.span
                key={detail}
                data-slot="ai-status-detail"
                variants={swapVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={swap}
                className={styles.detail}
              >
                <span className={styles.detailText}>{detail}</span>
              </motion.span>
            ) : null}
          </AnimatePresence>
          {time && active ? (
            <span data-slot="ai-status-timer" aria-hidden className={styles.timer}>
              {time}
            </span>
          ) : null}
        </div>
      </motion.div>
    </div>
  )
}

export const AiStatusIcon = ({ state }: { state: AiStatusState }) => {
  const reduced = !!useReducedMotion()
  const loop = (transition: Transition) => (reduced ? INSTANT : transition)

  switch (state) {
    case 'thinking':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={styles.glyph}>
          <motion.path
            d={SPARKLE_PATH}
            fill="currentColor"
            animate={reduced ? undefined : { rotate: [0, 90], scale: [1, 0.8, 1] }}
            transition={loop({ duration: 2.4, ...LOOP })}
          />
          <motion.path
            d={TWINKLE_PATH}
            fill="currentColor"
            animate={reduced ? undefined : { scale: [0.4, 1, 0.4], opacity: [0.3, 1, 0.3] }}
            transition={loop({ duration: 1.2, ...LOOP })}
          />
        </svg>
      )
    case 'researching':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={styles.glyph}>
          <motion.g
            animate={reduced ? undefined : { x: [0, 2, 0, -2, 0], y: [-2, 0, 2, 0, -2] }}
            transition={loop({ duration: 2, repeat: Infinity, ease: 'linear' })}
          >
            <circle {...STROKE} cx={10.5} cy={10.5} r={5.5} strokeWidth={2.25} />
            <path {...STROKE} d="M14.75 14.75L19 19" strokeWidth={2.5} />
          </motion.g>
        </svg>
      )
    case 'analyzing':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={styles.glyph}>
          {[6, 12, 18].map((x, index) => (
            <motion.line
              key={x}
              {...STROKE}
              x1={x}
              x2={x}
              y1={10}
              y2={19}
              strokeWidth={3}
              animate={reduced ? undefined : { y1: [15, 5, 15] }}
              transition={loop({ duration: 0.9, delay: index * 0.15, ...LOOP })}
            />
          ))}
        </svg>
      )
    case 'writing':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={styles.glyph}>
          <g transform="translate(-1.2 -2)">
            <motion.path
              {...STROKE}
              d={WAVE_PATH}
              strokeWidth={2.25}
              initial={false}
              animate={
                reduced
                  ? { pathLength: 1 }
                  : { pathLength: [...WAVE_PROGRESS, 1, 1], opacity: [...WAVE_PROGRESS.map(() => 1), 1, 0] }
              }
              transition={loop(SCRIBBLE)}
            />
            <motion.g
              initial={false}
              animate={
                reduced
                  ? { x: WAVE_X[WAVE_X.length - 1], y: WAVE_Y[WAVE_Y.length - 1] }
                  : {
                      x: [...WAVE_X, WAVE_X[WAVE_X.length - 1], WAVE_X[0]],
                      y: [...WAVE_Y, WAVE_Y[WAVE_Y.length - 1], WAVE_Y[0]],
                    }
              }
              transition={loop(SCRIBBLE)}
            >
              <path d={PEN_PATH} fill="currentColor" transform="scale(0.66) translate(-3 -21)" />
            </motion.g>
          </g>
        </svg>
      )
    case 'done':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={styles.glyph}>
          <motion.path
            {...STROKE}
            d="M5 12.5L10 17.5L19 7"
            strokeWidth={2.5}
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={reduced ? INSTANT : { type: 'spring', duration: 0.6, bounce: 0, delay: 0.1 }}
          />
        </svg>
      )
    case 'error':
      return (
        <svg viewBox="0 0 24 24" width={18} height={18} className={clsx(styles.glyph, styles.glyphError)}>
          <motion.path
            {...STROKE}
            d="M7 7L17 17M17 7L7 17"
            strokeWidth={2.5}
            animate={reduced ? undefined : { x: [0, -3, 3, -2, 2, 0] }}
            transition={{ duration: 0.45, delay: 0.1 }}
          />
        </svg>
      )
    default:
      return (
        <motion.span
          className={styles.dot}
          animate={reduced ? undefined : { scale: [1, 0.7, 1], opacity: [1, 0.5, 1] }}
          transition={loop({ duration: 1.2, ...LOOP })}
        />
      )
  }
}

const Shimmer = ({ reduced, children }: { reduced: boolean; children: ReactNode }) => {
  if (reduced) {
    return <span className={styles.labelIdle}>{children}</span>
  }
  return (
    <motion.span
      className={styles.shimmer}
      initial={{ backgroundPosition: '100% 0' }}
      animate={{ backgroundPosition: '0% 0' }}
      transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.span>
  )
}
