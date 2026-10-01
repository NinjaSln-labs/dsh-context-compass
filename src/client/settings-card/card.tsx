/**
 * C2 罗盘配置卡——**渲染层已换成宿主设计系统**。
 *
 * 0.2.0 之前这里是一整套自绘控件（`.sh-cf-*` 样式 + 手写标记），在 Plugins 页里
 * 和宿主自己的插件条目长得完全不像。现在直接用
 * `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm` / `SettingsValueField`，
 * 与 bash/subagent/web-search 等宿主插件配置页同源同 token。
 *
 * 两处必须自己做的：
 * 1. **视图分流**。`plugins.item` 有两个视图：`summary` 是插件列表里的一行描述，
 *    `page` 才是详情页的表单。此前无视 `view` 把整张表单塞进列表行——这正是
 *    「不符合统一界面设计」的直接原因。
 * 2. **布尔控件**。宿主的 settings-form 只提供文本/数值与密钥两种字段组件，
 *    没有布尔字段。这里用同包的 `Checkbox`——它的文档写明「caller-owned
 *    visible and accessible label」，自带可见标签与原生键盘语义。
 *    （最初选的是 `Switch`，但它把 label 只当 `aria-label`、不渲染可见文字，
 *    要补标签就得自己写标记——那又变回自绘。故改用 Checkbox。）
 *
 * 数据层没换：宿主的 `SettingsFormModel` 写路径是 `path: [field]`（单段），
 * 而本插件配置是 `thresholds.windowMid` 这样的嵌套结构，用它会把带点的键当成
 * 字面顶层键写进去。嵌套读写仍由本目录的 `CompassCardForm` 承担。
 */
import * as React from 'react'
import { SettingsForm, SettingsValueField, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { GROUPS, type FieldSpec } from './fields.ts'
import type { CompassCardState, CompassFieldState } from './index.ts'

/** 宿主 SettingsForm 需要的文案。 */
const FORM_LABELS = {
  unavailable: '本插件的配置项当前不可用',
  readOnly: '配置文件为只读，无法保存',
  saveFailed: '保存未生效，修改仍保留在表单里',
  save: '保存',
  saving: '保存中…',
} as const

/** 字段级共用文案。 */
const FIELD_LABELS = {
  overridden: '已修改',
  reset: '恢复默认',
  invalidNumber: '请输入有效数值',
} as const

/** 列表页那一行的一句话描述（summary 视图）。 */
const SUMMARY = '阈值、检查项、投影与计费配置'

/**
 * 字段种类 → 宿主控件，**渲染的唯一来源**（组件与 client-mount 的断言共用它，
 * 不允许出现「测的映射 ≠ 渲染的映射」两份实现——0.12.1 修过一次同类问题：
 * 渲染写死 decimal、映射函数返回 numeric，两者从未一致过）。
 *
 * 布尔走 Switch（宿主 settings-form 没有布尔字段组件，Switch 来自同一个
 * primitives 包，token 一致）；其余一律走 SettingsValueField。
 */
export function controlKindFor(spec: FieldSpec): 'checkbox' | 'value' {
  return spec.kind === 'boolean' ? 'checkbox' : 'value'
}

export interface SettingsCardProps {
  /** 宿主给的两个视图：列表行描述 / 详情页表单。 */
  view: 'summary' | 'page'
  store: { getSnapshot(): CompassCardState; subscribe(listener: () => void): () => void }
  actions: {
    editText(key: string, text: string): void
    toggle(key: string, checked: boolean): void
    resetField(key: string): void
    save(): void
    discard(): void
  }
}

export function SettingsCard({ view, store, actions }: SettingsCardProps): React.JSX.Element {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (view === 'summary') return <>{SUMMARY}</>
  const disabled = !state.writable
  return (
    <SettingsForm
      labels={FORM_LABELS}
      state={state}
      onSave={actions.save}
      onDiscard={actions.discard}
    >
      {GROUPS.map(group => (
        <section key={group.key} data-compass-group={group.key}>
          <h3>{group.title}</h3>
          {state.fields
            .filter(f => f.spec.group === group.key)
            .map(({ key, spec, field }) =>
              controlKindFor(spec) === 'checkbox'
                ? <CheckboxField key={key} spec={spec} field={field} disabled={disabled}
                    onToggle={checked => actions.toggle(key, checked)} />
                : <ValueField key={key} spec={spec} field={field} disabled={disabled}
                    onEdit={text => actions.editText(key, text)}
                    onReset={() => actions.resetField(key)} />,
            )}
        </section>
      ))}
    </SettingsForm>
  )
}

/** 数值/文本字段：直接用宿主控件，仅在需要时补 select 分支。 */
function ValueField({
  spec, field, disabled, onEdit, onReset,
}: {
  spec: FieldSpec
  field: CompassFieldState
  disabled: boolean
  onEdit(text: string): void
  onReset(): void
}): React.JSX.Element {
  return (
    <SettingsValueField
      id={`compass-${spec.path.join('-')}`}
      label={spec.label}
      hint={hintOf(spec)}
      text={field.text}
      overridden={field.overridden}
      invalid={field.invalid}
      disabled={disabled}
      numeric={spec.kind === 'number'}
      overriddenLabel={FIELD_LABELS.overridden}
      resetLabel={FIELD_LABELS.reset}
      invalidLabel={field.error ?? FIELD_LABELS.invalidNumber}
      onEdit={onEdit}
      onReset={onReset}
    />
  )
}

/**
 * 布尔字段：用宿主 `Checkbox`（自带可见标签 + 原生键盘语义）。提示文案走
 * `title`，与 SettingsValueField 的 hint 不同——checkbox 没有 hint 行位置，
 * 悬停提示是这一形态下唯一不引入自有样式的表达。
 */
function CheckboxField({
  spec, field, disabled, onToggle,
}: {
  spec: FieldSpec
  field: CompassFieldState
  disabled: boolean
  onToggle(checked: boolean): void
}): React.JSX.Element {
  return (
    <div data-compass-field="boolean" data-overridden={field.overridden || undefined}>
      <Checkbox
        checked={field.checked}
        disabled={disabled}
        onChange={onToggle}
        label={field.overridden ? `${spec.label}（${FIELD_LABELS.overridden}）` : spec.label}
        title={hintOf(spec)}
      />
    </div>
  )
}

/** hint 拼装：帮助文案 + restart-only 标注。 */
function hintOf(spec: FieldSpec): string {
  const parts: string[] = []
  if (spec.hint !== '') parts.push(spec.hint)
  if (spec.restartNote !== undefined) parts.push(spec.restartNote)
  return parts.join(' ')
}
