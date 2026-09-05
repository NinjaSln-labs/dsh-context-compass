/**
 * C2 罗盘配置卡片（自建控件，无官方 UI 值 import）。
 *
 * 组件只消费 index.ts 的 store/actions，不直接依赖宿主 settings 服务；
 * 字段布局、校验、保存提示全部基于 CompassCardState。
 */
import * as React from 'react'
import { GROUPS, type FieldSpec } from './fields.ts'
import type { CompassCardState } from './index.ts'

/** 控件形态纯函数：client-mount 可通过 lib 产物断言。 */
export function controlFor(spec: FieldSpec, field: { text: string; checked: boolean; invalid: boolean }) {
  switch (spec.kind) {
    case 'boolean':
      return { type: 'checkbox', checked: field.checked }
    case 'number':
      return { type: 'text', inputMode: 'numeric' as const, text: field.text }
    case 'strings':
      return { type: 'text', text: field.text }
    case 'select':
      return { type: 'select', options: spec.options ?? [] }
    default:
      return { type: 'text', text: field.text }
  }
}

/** 保存按钮 blocked 判定：!dirty || invalid || saving。 */
export function saveBlocked(state: Pick<CompassCardState, 'dirty' | 'invalid' | 'saving'>): boolean {
  return !state.dirty || state.invalid || state.saving
}

const SAVE_FAILED_TEXT = '本部署没有接受这些值，已保留供你修改。'

function FieldControl(props: {
  spec: FieldSpec
  field: CompassCardState['fields'][number]['field']
  saving: boolean
  writable: boolean
  onEdit(key: string, text: string): void
  onToggle(key: string, checked: boolean): void
}): JSX.Element {
  const { spec, field, saving, writable, onEdit, onToggle } = props
  const disabled = saving || !writable
  const key = spec.path.join('.')
  const fieldId = `cf-${key}`
  const hintId = `cf-${key}-hint`
  const errorId = `cf-${key}-error`
  const describedBy = [spec.hint ? hintId : undefined, field.error ? errorId : undefined].filter(Boolean).join(' ') || undefined
  if (spec.kind === 'boolean') {
    return React.createElement('input', {
      type: 'checkbox',
      id: fieldId,
      checked: field.checked,
      disabled,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onToggle(key, e.target.checked),
      className: 'sh-cf-checkbox',
      'aria-describedby': describedBy,
    })
  }
  if (spec.kind === 'select') {
    return React.createElement(
      'select',
      {
        id: fieldId,
        value: field.text,
        disabled,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onEdit(key, e.target.value),
        className: field.invalid ? 'sh-cf-invalid sh-cf-select' : 'sh-cf-select',
        'aria-describedby': describedBy,
        'aria-invalid': field.invalid || undefined,
      },
      ...(spec.options ?? []).map(o => React.createElement('option', { key: o.value, value: o.value }, o.label)),
    )
  }
  return React.createElement('input', {
    id: fieldId,
    type: 'text',
    inputMode: spec.kind === 'number' ? 'decimal' : undefined,
    value: field.text,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onEdit(key, e.target.value),
    className: field.invalid ? 'sh-cf-invalid sh-cf-input' : 'sh-cf-input',
    'aria-describedby': describedBy,
    'aria-invalid': field.invalid || undefined,
  })
}

export function SettingsCard(props: {
  store: { getSnapshot(): CompassCardState; subscribe(l: () => void): () => void }
  actions: {
    editText(key: string, text: string): void
    toggle(key: string, checked: boolean): void
    resetField(key: string): void
    save(): void
    discard(): void
  }
}): JSX.Element {
  const state = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const [open, setOpen] = React.useState(true)
  if (!state.available) return null as unknown as JSX.Element
  const disabled = state.saving || !state.writable
  return React.createElement(
    'div',
    { className: 'sh-cf-card' },
    React.createElement(
      'div',
      { className: 'sh-cf-header' },
      React.createElement('button', {
        type: 'button',
        className: 'sh-cf-chevron',
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        'aria-controls': 'sh-cf-body',
        'aria-label': '展开或折叠上下文罗盘配置',
      }, open ? '▾' : '▸'),
      React.createElement('div', { id: 'sh-cf-title', className: 'sh-cf-title' }, '上下文罗盘配置'),
      React.createElement('div', { className: 'sh-cf-desc' }, '阈值/检查项即时生效；计费定价改动需重启'),
    ),
    !state.writable && React.createElement('div', { className: 'sh-cf-readonly' }, '当前只读（部署未开启本地写）。'),
    open &&
      React.createElement(
        'div',
        { id: 'sh-cf-body', className: 'sh-cf-body' },
        GROUPS.map(g => React.createElement(
          'section',
          { key: g.key, className: 'sh-cf-group' },
          React.createElement('h3', { className: 'sh-cf-group-title' }, g.title),
          state.fields
            .filter(f => f.spec.group === g.key)
            .map(f => {
              const key = f.key
              const overridden = f.field.overridden
              return React.createElement(
                'div',
                { key, className: 'sh-cf-field' },
                React.createElement('div', { className: 'sh-cf-field-top' },
                  React.createElement('label', { htmlFor: `cf-${key}`, className: 'sh-cf-label' }, f.spec.label),
                  overridden && React.createElement('button', {
                    type: 'button',
                    className: 'sh-cf-reset',
                    disabled,
                    onClick: () => props.actions.resetField(key),
                    'aria-label': `恢复默认：${f.spec.label}`,
                  }, '恢复默认'),
                  f.spec.restartNote && React.createElement('span', { className: 'sh-cf-restart' }, f.spec.restartNote),
                ),
                React.createElement(FieldControl, {
                  spec: f.spec,
                  field: f.field,
                  saving: state.saving,
                  writable: state.writable,
                  onEdit: props.actions.editText,
                  onToggle: props.actions.toggle,
                }),
                f.spec.hint && React.createElement('div', { id: `cf-${key}-hint`, className: 'sh-cf-hint' }, f.spec.hint),
                f.field.invalid && React.createElement('div', { id: `cf-${key}-error`, className: 'sh-cf-error', role: 'alert' }, f.field.error ?? '请输入有效数值'),
              )
            }),
        )),
        React.createElement('div', { className: 'sh-cf-footer', role: 'status', 'aria-live': 'polite' },
          state.failed && React.createElement('div', { className: 'sh-cf-failed' }, SAVE_FAILED_TEXT),
          state.saving && React.createElement('span', { className: 'sh-cf-saving' }, '保存中…'),
          state.dirty &&
            React.createElement('button', {
              type: 'button',
              className: 'sh-cf-save',
              disabled: saveBlocked(state),
              onClick: () => props.actions.save(),
              'aria-label': '保存当前配置',
            }, '保存'),
          state.dirty &&
            React.createElement('button', {
              type: 'button',
              className: 'sh-cf-discard',
              disabled: saveBlocked(state),
              onClick: () => props.actions.discard(),
              'aria-label': '放弃当前修改',
            }, '放弃'),
        ),
      ),
  )
}
