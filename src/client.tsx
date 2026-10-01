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
    /**
     * Plugins 页里的插件配置项（0.2.0-rc.2 起的落点）。
     *
     * 旧落点 `settings.plugin.item` 在 0.2.0 的 slot 注册表里已不存在——
     * 现行的是 `plugins.item`（bash / subagent / web-search 等插件自身配置
     * 都注册在这里）与 `settings.general.item`。本插件是插件自身的配置项，
     * 归 `plugins.item` 才与同类同构。
     */
    'plugins.item': {
      kind: 'list'
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
import type { CompassScopeLike } from './client/settings-card/card-form.ts'
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
// uiWorkspace 是必需的：0.2.0-rc.2 起会话导航只此一条（ctx.sessions.open 已删）。
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale', 'uiWorkspace']

/** Client entry: register the badge + the multi-session overview panel seats. */
export function apply(ctx: Context): void {
  injectStyles()

  const sessions = ctx.sessions as unknown as {
    binding(sessionId: string): { session: { projections: { faceOf(key: string): ProjectionFace | undefined } } } | undefined
    /** Session-list store: byId rows carry `updatedAt` (last activity, epoch ms). */
    list: { getSnapshot(): { byId: Record<string, { updatedAt?: number }> } }
  }
  // 0.2.0-rc.2：会话导航不在 ctx.sessions 上（ISessions 注释：navigation belongs
  // to view owners），改由视图 owner 提供。缺它时面板仍可浏览，只是点行不跳转。
  const uiWorkspace = (ctx as unknown as {
    uiWorkspace?: { openSession(target: string): void }
  }).uiWorkspace
  const commands = (ctx.remote as unknown as { commands: CommandsRemote }).commands
  const locale = (ctx as unknown as { locale: { snapshot: { active: string } } }).locale

  // Multi-session overview: the sidebar-foot opener and the frame overlay
  // share one open-state store created per apply (disposed with the fiber —
  // a re-apply starts fresh, an unload takes the registrations with it).
  const overviewStore = new OverviewStore()

  // C2：罗盘配置卡。0.2.0-rc.2 起底座是宿主的 `configForms` 服务（旧的
  // `settingsScope` 已移除），页面注册也从 `settings.plugin.item` 迁到了
  // `plugins.item`——旧 slot 在 0.2.0 的注册表里已不存在，即便底座可用也
  // 永远渲染不出来。两处都是宿主契约，不可凭直觉沿用旧名。
  //
  // configForms 仍按**可选**服务处理：探测不到只跳过配置卡，徽章/一览面板/
  // 命令卡照常注册。宁可少一张卡，也不要因为配置面挂掉拖垮整个 client 包。
  const configForms = (ctx as unknown as {
    get(name: string): {
      get(entryId: string): CompassScopeLike
      whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
    } | undefined
  }).get('configForms')
  const compassCard = configForms === undefined ? undefined : createSettingsCard(configForms.get('context-compass'))

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
        uiWorkspace={uiWorkspace}
        commands={commands}
        locale={locale}
      />
    ),
  ) as never)
  // C2 配置卡：与 C1 的 settings.configure({auto:true}) 配成一对两半——
  // 宿主侧声明本条目可配置，客户端侧在宿主真的提供该命名空间时才注册页面。
  // `whileServed` 是宿主的门控：命名空间没被提供就不注册（部署里没组合到宿主
  // 插件时，页面连痕迹都不留），这正是现行 bash/subagent/web-search 的写法。
  if (configForms !== undefined && compassCard !== undefined) {
    ctx.effect(() => configForms.whileServed(['context-compass'], () => ctx.slots.inject('plugins.item', () => ctx.slots.register(
      {
        name: 'plugins.item',
        id: 'context-compass',
        order: 90,
        // label 是账本的显示名：`plugins.item` 在 plugin-manager 里被投影成
        // `{ id, label }` 列表，label 缺失就只出现一行空白条目（宿主 shell /
        // subagent / web-search 全部都带）。
        label: '上下文罗盘配置',
      } as never,
      () => <SettingsCard store={compassCard.store} actions={compassCard.actions} />,
    ) as never)))
    ctx.effect(() => () => { try { compassCard.dispose() } catch { /* ignore */ } })
  } else {
    console.warn(
      '[dsh-context-compass] configForms 服务不可用（宿主 0.2.0-rc.2 起配置页底座由 settingsScope 换成 configForms）'
      + '——跳过插件配置卡；徽章/命令卡/一览面板不受影响。配置请改 profile patch。',
    )
  }
}

