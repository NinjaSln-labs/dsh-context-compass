/**
 * Node 侧的宿主设置组件桩。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 是浏览器组件：它 import CSS module
 * （`StateDot.module.css`），Node 直接 import 会 ERR_UNKNOWN_FILE_EXTENSION。
 * client-mount 需要在 Node 里跑我们的卡片逻辑，就在这里把宿主组件换成最小实现
 * ——被替换掉的是**宿主的渲染与样式**，本仓卡片的组装、字段投影、动作接线仍
 * 是真的在跑。真实渲染由 visual 套件在浏览器里验。
 */
import * as React from 'react'

const h = React.createElement

export function SettingsForm({ labels, state, onSave, onDiscard, children }) {
  return h('div', { 'data-stub': 'SettingsForm', 'data-available': String(state.available), 'data-dirty': String(state.dirty) },
    h('span', { 'data-stub-label': 'save' }, labels.save),
    h('span', { 'data-stub-label': 'discard' }, String(typeof onDiscard === 'function')),
    h('button', { type: 'button', 'data-stub-control': 'save', onClick: onSave }, labels.save),
    children,
  )
}

export function SettingsValueField(props) {
  return h('div', { 'data-stub': 'SettingsValueField', 'data-field': props.id, 'data-overridden': String(props.overridden) },
    h('label', null, props.label),
    h('input', {
      value: props.text,
      disabled: props.disabled,
      onChange: (e) => props.onEdit(e.target.value),
    }),
    h('button', { type: 'button', onClick: props.onReset }, props.resetLabel),
  )
}

export function SettingsSecretField(props) {
  return h('div', { 'data-stub': 'SettingsSecretField' }, h('label', null, props.label))
}

// 宿主 Checkbox 自带可见标签（Switch 只把 label 当 aria-label，不渲染文字）
export function Checkbox({ checked, onChange, label, disabled }) {
  return h('label', { 'data-stub': 'Checkbox' },
    h('input', { type: 'checkbox', checked, disabled, onChange: (e) => onChange(e.target.checked) }),
    h('span', null, label),
  )
}
