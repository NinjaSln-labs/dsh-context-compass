/**
 * dsh-context-compass — Client half.
 *
 * Entry point: registers the session-health badge, the /compass rich card,
 * and the multi-session overview panel seats. The implementation lives in
 * ./client/{styles,shared,badge,command-card,overview} — this file only wires
 * them into the four slots.
 *
 * Data flow: PURE projection push. The badge subscribes to the host-computed
 * `sessionHealth` projection (`sessions.binding(...).session.projections
 * .faceOf('sessionHealth')`), updated by `session/projection` frames the
 * moment the host fold changes — zero polling, zero RPC. The projection seam
 * is the one wire path community plugins own: the browser mounts a fixed,
 * build-time generated Remote list (api-remotes), so a plugin Remote such as
 * `remote.sessionHealth` can never mount — inject it and the entry stays
 * pending forever (web boot: waiting for service: remote.sessionHealth).
 *
 * Clicking the badge runs `/compass` through the core commands Remote
 * (`remote.commands`, always mounted) for the full textual report.
 */
// 0.2.0-rc.2 起宿主 client 入口签名是 cordis 原生 Context
// （dsh-cordis-client-runner/lib/types/client/index.d.ts:112
// `apply(ctx: Context)`）；旧的 @deepseek-ai/dsh-client-runtime 整包已移除。
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the header.utilities seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the two seats below live in OTHER ui packages (ui-sidebar
// declares sidebar.footer.action, ui-layout declares shell.overlay) that are
// not on this plugin's type resolution path. The runtime slot tree was
// verified via the harness Inspect provider; this local augmentation mirrors
// the owner-prop contracts from those packages' d.ts files (compile-time only
// — erased from the bundle; slots.inject on a runtime-missing key is inert).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Owner share of one action beside Settings at the sidebar foot. */
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean }
    }
    /** Frame-wide floating layer (list slot, no owner props). */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
    /** 设置 → 插件配置 → 罗盘配置卡（keyed by settings namespace）。 */
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}
import { injectStyles } from './client/styles.ts'
import { HealthBadge } from './client/badge.tsx'
import { CompassCommandCard } from './client/command-card.tsx'
import { OverviewAction, OverviewPanel, OverviewStore } from './client/overview.tsx'
import { createSettingsCard } from './client/settings-card/index.ts'
import { SettingsCard } from './client/settings-card/card.tsx'
import type { ProjectionFace, CommandsRemote } from './client/shared.ts'
// Re-export the report parser + pressure helpers — the client-mount test
// asserts them on the entry module (the pre-split client.tsx exported them).
export { parseCompassReport, mergePressure, lagOf, type CompassReport, type ContextPressureLike } from './client/shared.ts'

/** Package id — must match package.json `name` and the ModuleLoader handoff. */
export const name = 'dsh-context-compass'

/**
 * Required client services. Cordis forbids `ctx.remote` / `ctx.sessions` /
 * `ctx.slots` property reads unless they appear here (topology-sensitive
 * proxy; "cannot get property X without inject"). Both the `remote` root and
 * the `remote.commands` sub-service are injected, mirroring the in-tree
 * convention (ui-goal: ['slots','sessions','remote','remote.goals',...]).
 * There is deliberately NO `remote.sessionHealth`: plugin Remotes never mount
 * client-side, and an injected one would leave the entry pending forever.
 *
 * `settingsScope` (C2 配置卡) is likewise **not** required: the host removed that
 * service in 0.2.0-rc.2 (settings 改由 `SettingsForms` 从 Config schema 自动派生，
 * client 侧不再有 per-namespace scope）。把它留在 required inject 里 = 整个 entry
 * 永远 pending → **整个 client bundle 静默不挂载**（徽章/面板/命令卡全没，零报错）。
 * C2 改为下面 `bindCompassCard()` 里的可选探测。
 */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/** Client entry: register the badge + the multi-session overview panel seats. */
export function apply(ctx: Context): void {
  injectStyles()

  const sessions = ctx.sessions as unknown as {
    binding(sessionId: string): { session: { projections: { faceOf(key: string): ProjectionFace | undefined } } } | undefined
    open(id: string): void
    /** Session-list store: byId rows carry `updatedAt` (last activity, epoch ms). */
    list: { getSnapshot(): { byId: Record<string, { updatedAt?: number }> } }
  }
  const commands = (ctx.remote as unknown as { commands: CommandsRemote }).commands
  const locale = (ctx as unknown as { locale: { snapshot: { active: string } } }).locale

  // Multi-session overview: the sidebar-foot opener and the frame overlay
  // share one open-state store created per apply (disposed with the fiber —
  // a re-apply starts fresh, an unload takes the registrations with it).
  const overviewStore = new OverviewStore()

  // C2：罗盘配置卡 controller。`settingsScope` 是**可选**服务——
  // 宿主 0.2.0-rc.2 起已移除该服务（settings 改为 SettingsForms 从 schema 派生），
  // 探测不到时只跳过配置卡，徽章/一览面板/命令卡照常注册。
  // cast：宿主 SettingsScope 与自建 CompassScopeLike 因 mutate 参数逆变不直接兼容，
  // 用双 cast（as unknown as）保证通过（形状已由契约复核确认，语义明确）。
  const compassCard = bindCompassCard(ctx)
  if (compassCard !== undefined) {
    ctx.effect(() => () => { try { compassCard.dispose() } catch { /* ignore */ } })
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'session-health-dot', order: 10 } as never,
    (props: { sessionId: string }) => (
      <HealthBadge
        sessionId={props.sessionId}
        sessions={sessions}
        commands={commands}
        locale={locale}
      />
    ),
  ) as never)

  // /compass rich card: the commandview seat dispatches by command name and
  // is currently unoccupied — registering 'compass' upgrades the row.
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
    { name: 'conversation.chat.commandview', key: 'compass' } as never,
    (props: { node: never }) => <CompassCommandCard node={props.node} />,
  ) as never)

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'session-health-overview', order: 10 } as never,
    (props: { wide: boolean }) => (
      <OverviewAction wide={props.wide} store={overviewStore} />
    ),
  ) as never)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'session-health-overview-panel', order: 10 } as never,
    () => (
      <OverviewPanel
        store={overviewStore}
        sessions={sessions}
        commands={commands}
        locale={locale}
      />
    ),
  ) as never)
  // C2 配置卡只在 settingsScope 可用时注册（宿主 0.2.0-rc.2 起无此服务）。
  if (compassCard !== undefined) {
    ctx.slots.inject('settings.plugin.item', function* () {
      yield ctx.slots.register(
        { name: 'settings.plugin.item', key: 'context-compass' } as never,
        () => <SettingsCard store={compassCard.store} actions={compassCard.actions} />,
      ) as never
    })
  }
}

/**
 * C2 配置卡的 controller。`settingsScope` 缺失（宿主 0.2.0-rc.2 起移除该服务）
 * 时返回 undefined 并告警——**不能抛**：apply 抛错会让本 entry 整个挂载失败，
 * 连带徽章、一览面板、命令卡一起消失。
 *
 * 必须用 `ctx.get(name)` 探，**不能读 `ctx.settingsScope` 属性**：cordis 的拓扑
 * 代理会对未在 inject 列表里的属性读直接抛 `cannot get property "settingsScope"
 * without inject`（0.2.0-rc.2 首次实测撞到）。`ctx.get` 是唯一无 inject 要求的读法，
 * 未提供时返回 undefined。
 */
function bindCompassCard(ctx: Context): ReturnType<typeof createSettingsCard> | undefined {
  const scope = (ctx as unknown as { get(name: string): { bind(spec: { namespace: string }): unknown } | undefined })
    .get('settingsScope')
  if (scope === undefined || typeof scope.bind !== 'function') {
    console.warn(
      '[dsh-context-compass] settingsScope 服务不可用（宿主 0.2.0-rc.2 起已移除）——'
      + '跳过设置页配置卡；徽章/命令卡/一览面板不受影响。配置请改配置文件。',
    )
    return undefined
  }
  try {
    // bind 返回的 scope 已挂 dispose 到调用方 fiber（官方 bind 内置 ctx.effect）
    return createSettingsCard(scope.bind({ namespace: 'context-compass' }) as unknown as Parameters<typeof createSettingsCard>[0])
  } catch (err) {
    console.warn(`[dsh-context-compass] 配置卡绑定失败，跳过设置页卡片：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
