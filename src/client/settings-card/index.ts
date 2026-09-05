/**
 * C2 罗盘配置卡装配器。
 *
 * 把宿主 settingsScope 绑到 context-compass 命名空间，并把 CompassCardForm 的
 * shell/field 投影投影为 React store 可用的 CompassCardState。字段清单、
 * 草稿状态机与写路径都在本目录内的纯逻辑模块里，client.tsx 只负责挂到槽位。
 */
import { CompassCardForm, type CompassScopeLike, type CompassShell, type FieldDraftState } from './card-form.ts'
import { FIELDS, type FieldSpec } from './fields.ts'

/** 卡片完整投影 state：shell + 全字段 field/currentValue（store 快照）。 */
export interface CompassCardState extends CompassShell {
  fields: Array<{ key: string; spec: FieldSpec; field: FieldDraftState; value: unknown }>
}

export function createSettingsCard(scope: CompassScopeLike) {
  const form = new CompassCardForm(scope, FIELDS)
  const project = (): CompassCardState => ({
    ...form.shell(),
    fields: FIELDS.map(f => {
      const key = f.path.join('.')
      return { key, spec: f, field: form.field(key), value: form.currentValue(key) }
    }),
  })
  const store = form.bind(project)
  return { store, actions: form.actions(), dispose: () => form.dispose() }
}
