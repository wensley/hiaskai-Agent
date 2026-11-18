import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconRefreshOutline16,
} from '../base/icons.js'
import {
  BUILTIN_MODELS,
  customModelOptionList,
  fetchRemoteModels,
  modelLabel,
  readCachedModels,
  type ModelOption,
} from '../../services/api/models.js'
import { setModel, updateCustomModel, useSettings } from '../../services/settings.js'
import { customSelection, probeCustomModel } from '../../services/api/providers.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ModelPicker.module.css'

/** 自定义模型排最前（用户刚配的就是想用的），其次远端，最后内置兜底 */
const mergeModels = (remote: ModelOption[], custom: ModelOption[]): ModelOption[] => {
  const seen = new Set<string>()
  return [...custom, ...remote, ...BUILTIN_MODELS].filter((item) => {
    if (seen.has(item.id)) {
      return false
    }
    seen.add(item.id)
    return true
  })
}

/**
 * 模型选择：优先展示远端 /models 拉取的列表，失败时退回缓存与内置列表。
 * 选择结果写入设置，下一次请求直接使用该 id。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const mockAgent = useSettings((state) => state.mockAgent)
  const [open, setOpen] = useState(false)
  const customModels = useSettings((state) => state.customModels)
  const [models, setModels] = useState<ModelOption[]>(() =>
    mergeModels(readCachedModels() ?? [], customModelOptionList())
  )
  const [loading, setLoading] = useState(false)
  const [, setSource] = useState<'cache' | 'remote' | 'builtin'>(
    readCachedModels() ? 'cache' : 'builtin'
  )
  const fetched = useRef(false)

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 320,
    minSpace: 200,
    measureKey: models.length,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const refresh = useCallback(
    async (silent = false) => {
      const settings = useSettings.getState()
      const apiKey = settings.apiKey ?? ''
      // 选中的是自定义模型时刷新它自己的接口，而不是内置 DeepSeek
      const selected = settings.customModels.find(
        (item) => customSelection(item.uid) === settings.model
      )
      setLoading(true)
      try {
        if (selected) {
          const { models: list } = await probeCustomModel(selected, apiKey)
          if (list.length === 0) {
            throw new Error('empty model list')
          }
          // 名称还是模型 ID 的条目，用接口给的显示名补全
          for (const item of list) {
            const saved = settings.customModels.find((entry) => entry.model === item.id)
            if (saved && saved.label === saved.model && item.label !== item.id) {
              updateCustomModel(saved.uid, { label: item.label })
            }
          }
          setSource('remote')
          if (!silent) {
            showToast({ key: 'modelRefreshCustomOk', params: { count: list.length } })
          }
          return
        }
        if (!apiKey) {
          setSource(readCachedModels() ? 'cache' : 'builtin')
          if (!silent) {
            showToast({ key: 'modelRefreshNoKey' })
          }
          return
        }
        const remote = await fetchRemoteModels(apiKey)
        setModels(mergeModels(remote, customModelOptionList()))
        setSource('remote')
      } catch {
        setSource(readCachedModels() ? 'cache' : 'builtin')
        if (!silent) {
          showToast({ key: 'modelFetchFailed' })
        }
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // 首次打开时自动拉取一次；演示模式没有真实 Key，直接使用内置列表
  useEffect(() => {
    if (!open || fetched.current || mockAgent) {
      return
    }
    fetched.current = true
    if (!readCachedModels()) {
      void refresh(true)
    }
  }, [open, mockAgent, refresh])

  // 设置里增删自定义模型后，选择器立即跟着变
  useEffect(() => {
    setModels((current) =>
      mergeModels(
        current.filter((item) => item.source === 'remote'),
        customModelOptionList(customModels)
      )
    )
  }, [customModels])

  /** 当前选中的是自定义模型时，刷新动作改为刷新它的接口 */
  const selectedCustom = customModels.find((item) => customSelection(item.uid) === model)

  const sourceText = useMemo(() => {
    if (loading) {
      return t('modelRefreshing')
    }
    // 缓存里的远端列表同样按远端展示，刷新失败才回落到内置文案
    const remoteCount = models.filter((item) => item.source === 'remote').length
    const customCount = models.filter((item) => item.source === 'custom').length
    const base =
      remoteCount > 0 ? t('modelRemoteOk', { count: remoteCount }) : t('modelBuiltinFallback')
    return customCount > 0
      ? `${base} · ${t('modelCustomCount', { count: customCount })}`
      : base
  }, [loading, models, t])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={t('modelSelect')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.caption}>{t('modelSelect')}</span>
        <span className={styles.name}>{modelLabel(model)}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSelect')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('modelSelect')}</span>
                <button
                  type="button"
                  className={clsx(styles.refresh, loading && styles.spinning)}
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <IconRefreshOutline16 />
                  {loading
                    ? t('modelRefreshing')
                    : selectedCustom
                      ? t('modelRefreshCustom')
                      : t('modelRemoteFetch')}
                </button>
                <button
                  type="button"
                  className={styles.refresh}
                  onClick={() => {
                    setOpen(false)
                    openSettings('models')
                  }}
                >
                  {t('modelCustomSection')}
                </button>
              </div>
              <div className={styles.list}>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === model}
                    className={clsx(styles.option, item.id === model && styles.active)}
                    onClick={() => {
                      setModel(item.id)
                      setOpen(false)
                    }}
                  >
                    <span className={styles.optionMain}>
                      <span className={styles.optionName}>{item.label}</span>
                      <span className={styles.optionId}>{item.hint ?? item.id}</span>
                    </span>
                    {item.id === model ? <IconCheckedOutline14 /> : null}
                  </button>
                ))}
              </div>
              <div className={styles.foot}>{sourceText}</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
