import { useState, type ReactNode } from 'react'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  customSelection,
  normalizeBaseUrl,
  probeCustomModel,
  type CustomModel,
  type ProviderProtocol,
} from '../../services/api/providers.js'
import {
  addCustomModel,
  removeCustomModel,
  setModel,
  updateCustomModel,
  useSettings,
  type CustomModelInput,
} from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import styles from './Settings.module.css'

type Draft = CustomModelInput

const toDraft = (model: CustomModel | null): Draft =>
  model
    ? {
        label: model.label,
        model: model.model,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        protocol: model.protocol,
        contextWindow: model.contextWindow,
        tools: model.tools,
        reasoning: model.reasoning,
      }
    : {
        label: '',
        model: '',
        baseUrl: '',
        apiKey: '',
        protocol: 'openai',
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        tools: true,
        reasoning: false,
      }

/**
 * 自定义模型：用户自己填接口地址、Key 与模型 ID，绕过内置的 DeepSeek 接口。
 * 所有配置只存在本机 localStorage，请求由浏览器直连服务商。
 */
export const CustomModels = () => {
  const t = useTranslate()
  const models = useSettings((state) => state.customModels)
  const [editing, setEditing] = useState<CustomModel | 'new' | null>(null)

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsModelsTitle')}</div>
          <div className={styles.description}>{t('settingsModelsHint')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          onClick={() => setEditing('new')}
        >
          {t('settingsModelsAdd')}
        </Button>
      </div>
      {models.length === 0 ? (
        <div className={styles.modelsEmpty}>{t('settingsModelsEmpty')}</div>
      ) : (
        <ul className={styles.modelsList}>
          {models.map((model) => (
            <li key={model.uid} className={styles.modelsItem}>
              <div className={styles.modelsMain}>
                <span className={styles.modelsName}>{model.label}</span>
                <span className={styles.modelsMeta}>
                  {model.model} · {model.baseUrl}
                </span>
              </div>
              <span className={styles.modelsBadge}>
                {model.protocol === 'openai'
                  ? t('settingsModelsProtocolOpenAI')
                  : t('settingsModelsProtocolAnthropic')}
              </span>
              <IconButton
                tone="primary"
                icon={<IconEditOutline16 />}
                tooltip={t('settingsModelsEdit')}
                aria-label={t('settingsModelsEdit')}
                onClick={() => setEditing(model)}
              />
              <IconButton
                tone="primary"
                icon={<IconTrashOutline16 />}
                tooltip={t('settingsModelsDelete')}
                aria-label={t('settingsModelsDelete')}
                onClick={() => removeCustomModel(model.uid)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className={styles.modelsFootnote}>{t('settingsModelsAttachmentHint')}</div>
      {editing ? (
        <CustomModelEditor
          model={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

const CustomModelEditor = ({
  model,
  onClose,
}: {
  model: CustomModel | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const [draft, setDraft] = useState<Draft>(() => toDraft(model))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null)
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }))

  const model_ = draft.model.trim()
  const baseUrl = normalizeBaseUrl(draft.baseUrl)
  const valid = model_ !== '' && /^https?:\/\//i.test(baseUrl)

  const save = () => {
    if (!valid) {
      setStatus({ error: true, text: t('settingsModelsInvalid') })
      return
    }
    const input: Draft = { ...draft, model: model_, baseUrl, label: draft.label.trim() || model_ }
    if (model) {
      updateCustomModel(model.uid, input)
    } else {
      const created = addCustomModel(input)
      if (created) {
        // 刚加完就想用：直接切到新模型，省一次选择器点击
        setModel(customSelection(created.uid))
      }
    }
    onClose()
  }

  const test = async () => {
    if (!valid || busy) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const probe = normalizeBaseModel(draft, model_, baseUrl)
      const count = await probeCustomModel(probe, useSettings.getState().apiKey)
      setStatus({ error: false, text: t('settingsModelsTestOk', { count }) })
    } catch (error) {
      setStatus({
        error: true,
        text: t('settingsModelsTestFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={model ? t('settingsModelsEditTitle') : t('settingsModelsAddTitle')}
      className={styles.editor}
      onClose={onClose}
      footer={
        <div className={styles.editorActions}>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void test()}>
            {busy ? t('settingsModelsTesting') : t('settingsModelsTest')}
          </Button>
          <Button variant="primary" size="m" disabled={!valid} onClick={save}>
            {t('settingsModelsSave')}
          </Button>
        </div>
      }
    >
      <div className={styles.editorForm}>
        <Field label={t('settingsModelsName')} hint={t('settingsModelsNameHint')}>
          <input
            className={styles.editorInput}
            value={draft.label}
            placeholder={t('settingsModelsNamePlaceholder')}
            onChange={(event) => patch({ label: event.target.value })}
          />
        </Field>
        <Field label={t('settingsModelsProtocol')} hint={t('settingsModelsProtocolHint')}>
          <Select
            ariaLabel={t('settingsModelsProtocol')}
            value={draft.protocol}
            options={[
              { value: 'openai', label: t('settingsModelsProtocolOpenAI') },
              { value: 'anthropic', label: t('settingsModelsProtocolAnthropic') },
            ]}
            onChange={(value) => patch({ protocol: value as ProviderProtocol })}
          />
        </Field>
        <Field label={t('settingsModelsModelId')} hint={t('settingsModelsModelIdHint')}>
          <input
            className={styles.editorInput}
            value={draft.model}
            placeholder={t('settingsModelsModelIdPlaceholder')}
            spellCheck={false}
            onChange={(event) => patch({ model: event.target.value })}
          />
        </Field>
        <Field label={t('settingsModelsBaseUrl')} hint={t('settingsModelsBaseUrlHint')}>
          <input
            className={styles.editorInput}
            value={draft.baseUrl}
            placeholder={t('settingsModelsBaseUrlPlaceholder')}
            spellCheck={false}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </Field>
        <Field label={t('settingsModelsApiKey')} hint={t('settingsModelsApiKeyHint')}>
          <input
            className={styles.editorInput}
            type="password"
            value={draft.apiKey}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
        </Field>
        <Field label={t('settingsModelsContextWindow')} hint={t('settingsModelsContextWindowHint')}>
          <input
            className={styles.editorInput}
            type="number"
            min={MIN_CONTEXT_WINDOW}
            max={MAX_CONTEXT_WINDOW}
            step={1000}
            value={draft.contextWindow}
            onChange={(event) => patch({ contextWindow: Number(event.target.value) })}
          />
        </Field>
        <Field label={t('settingsModelsTools')} hint={t('settingsModelsToolsHint')}>
          <Switch
            checked={draft.tools}
            label={t('settingsModelsTools')}
            onChange={(tools) => patch({ tools })}
          />
        </Field>
        <Field label={t('settingsModelsReasoning')} hint={t('settingsModelsReasoningHint')}>
          <Switch
            checked={draft.reasoning}
            label={t('settingsModelsReasoning')}
            onChange={(reasoning) => patch({ reasoning })}
          />
        </Field>
        {status ? (
          <div className={status.error ? styles.error : styles.editorOk}>{status.text}</div>
        ) : null}
      </div>
    </Modal>
  )
}

/** 测试连通性时构造一个完整的模型条目，不落库 */
const normalizeBaseModel = (
  draft: Draft,
  model: string,
  baseUrl: string
): CustomModel => ({
  ...draft,
  uid: 'probe',
  model,
  baseUrl,
  label: draft.label.trim() || model,
  createdAt: Date.now(),
  contextWindow: Math.min(
    MAX_CONTEXT_WINDOW,
    Math.max(MIN_CONTEXT_WINDOW, draft.contextWindow || DEFAULT_CONTEXT_WINDOW)
  ),
})

const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <span className={styles.fieldControl}>{children}</span>
    {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
  </label>
)
