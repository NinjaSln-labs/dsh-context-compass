/**
 * C2 罗盘配置卡装配器。
 *
 * 把宿主 settingsScope 绑到 context-compass 命名空间，并把 CompassCardForm 的
 * shell/field 投影投影为 React store 可用的 CompassCardState。字段清单、
 * 草稿状态机与写路径都在本目录内的纯逻辑模块里，client.tsx 只负责挂到槽位。
 */
import { CompassCardForm, type CompassScopeLike, type CompassShell, type FieldDraftState } from './card-form.ts'

/** 卡片消费的字段态（card.tsx 直接用）。 */
export type CompassFieldState = FieldDraftState
import { FIELDS, type FieldSpec } from './fields.ts'

/** 卡片完整投影 state：shell + 全字段 field/currentValue（store 快照）。 */
export interface CompassCardState extends CompassShell {
  fields: Array<{ key: string; spec: FieldSpec; field: FieldDraftState; value: unknown }>
}

/**
 * 卡里画的字段 = schema 标了 `.volatile()` 的那些。
 *
 * 0.2.0 的 SettingsForms.write 只接受 volatile 路径，非 volatile 字段会被
 * `isVolatilePath` 拒掉。把它们也画出来，用户改完点保存只会看到「保存未生效」，
 * 而且控件里是空的（form 快照根本没有这些字段）——比不画更误导。
 * FIELDS[].writable 逐条对应 schema 的 .volatile() 标注，由 client-mount 断言
 * 两张清单必须一致，防止今后只改一边。
 */
export const CARD_FIELDS: readonly FieldSpec[] = FIELDS.filter(f => f.writable)

export function createSettingsCard(scope: CompassScopeLike) {
  const form = new CompassCardForm(scope, CARD_FIELDS)
  const project = (): CompassCardState => ({
    ...form.shell(),
    fields: CARD_FIELDS.map(f => {
      const key = f.path.join('.')
      return { key, spec: f, field: form.field(key), value: form.currentValue(key) }
    }),
  })
  const store = form.bind(project)
  return { store, actions: form.actions(), dispose: () => form.dispose() }
}
