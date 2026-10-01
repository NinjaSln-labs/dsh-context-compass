/**
 * dsh-context-compass — Host half.
 *
 * One plugin, three surfaces, one shared read-only assessment core:
 * - `sessionHealth` projection unit — reactive badge data (push frames, no
 *   polling, no Remote: community plugins cannot expose a Remote to the
 *   browser client — the client mounts a fixed generated list, see schemas.ts)
 * - `context_compass` tool — model-callable self-check in long tasks
 * - `/compass` command — user-initiated full textual report
 *
 * Data sources (all read-only, all real):
 * - ctx.tokenMeter.measure(session) — exact per-round input pressure
 * - llm.resolveModelInfo — model context window
 * - sessionQuery / sessionProjections — message/turn/compaction counts
 * - fs + sandboxPolicy — optional git / handoff-doc probes
 * - ctx.subprocess — optional read-only process probe
 */
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Config, resolveConfig, validateConfig, type Config as ConfigType, type ResolvedConfig } from './config.ts'
// dsh-settings@>=0.1.2-alpha.4: module-level exports removed; use ctx.inject + settings.installSection
import { sessionHealthProjectionDefinition } from './projection.ts'
import { healthCommandDefinition } from './command.ts'
import { sessionHealthTool } from './tool.ts'
import { PriceCache, startPricingRefresh, staticPricing } from './pricing.ts'
import { handleOverviewRpc, warmBlankTruth } from './overview.ts'

export { Config } from './config.ts'
export { sessionHealthProjectionDefinition, applyHealthEvent, healthView } from './projection.ts'
export { assess, type HealthReport, type AssessOptions } from './assess.ts'
export { healthCommandDefinition, buildCommandText } from './command.ts'
export { buildSnapshotText, probeCrossSession, KNOWLEDGE_SNAPSHOT_KEY } from './knowledge.ts'
export { sessionHealthTool } from './tool.ts'
export { buildOverview, sortOverviewRows, rankOf, clearTitleCache, warmBlankTruth, refreshBlankTruth, handleOverviewRpc, buildHandoffSummary, type OverviewRow } from './overview.ts'
export type * from './types.ts'

export const name = 'dsh-context-compass'

/**
 * Cordis plugin — OBJECT form (never a factory).
 *
 * The loader mounts `module.default` directly through `ctx.plugin()`: a
 * FUNCTION default is treated as the plugin body and invoked as
 * `(ctx, config)`, so a factory that merely RETURNS `{ apply }` is silently
 * ignored — no error, entry shows ACTIVE, apply never runs. The default
 * export must BE the plugin object (knowledge-sqlite hit this exact pitfall
 * on mount; fixed the same way).
 */
export default {
  name,
  Config,
  apply(ctx: Context, config: ConfigType = {}): void {
    // C1 live config source。0.2.0-rc.2 起宿主 settings 换成 `SettingsForms`
    // （从 Config schema 派生表单），旧的 `installSection` 已删除，setSource /
    // validate / onChange 三个钩子没有对应物。新的接法是：
    //   1. schema 里把「改完即生效」的字段标 `.volatile()`（见 config.ts）——
    //      SettingsForms 只暴露 volatile 字段，未标的连表单都不生成；
    //   2. `settings.configure({ auto: true })` 注册自动页面——宿主据此用本插件的
    //      Config schema 渲染原生配置表单，写入由它自己校验并落到 profile patch；
    //   3. 活源语义由 volatile 单元承担：volatile 字段解析出来是带 `.get()` 的
    //      活体单元，resolveConfig 每次读取都取当前快照，于是阈值改动在下一次
    //      使用时即可见——不再需要手工重绑定 source。
    let source: () => ResolvedConfig = () => resolveConfig(config)
    ctx.inject(['settings'], (sctx) => {
      try {
        sctx.effect(() => sctx.settings.configure({ auto: true }, sctx.fiber))
      } catch (err) {
        // 配置表单不可用（无 settings 服务 / 本条目没有 volatile 字段）。
        // 插件不崩，配置仍从入口 config 读——只是设置页没有本插件的表单。
        console.warn(
          `[dsh-context-compass] settings.configure 失败（配置表单不可用，配置请改 profile patch）：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
    // 跨字段护栏的落点变了。0.2.0 之前 `hooks.validate` 能**写时拒绝**非单调的
    // 阈值阶梯；新契约里 SettingsForms 只做 schema 级校验（范围/类型），跨字段
    // 关系没有对应钩子。与其丢掉这层保护（阶梯错乱会让 severity 排序静默失真），
    // 改为**读时兜底**：解析出的配置若违反单调性或含非有限值，就回落默认值并
    // 只告警一次。触发来源是被手改的 profile patch（settings 写入路径已被
    // schema 挡住），属罕见路径，兜底比抛错更合适。
    let guardWarned = false
    const guardedConfig = (): ResolvedConfig => {
      const resolvedNow = source()
      try {
        validateConfig(resolvedNow)
        return resolvedNow
      } catch (err) {
        if (!guardWarned) {
          guardWarned = true
          console.warn(
            `[dsh-context-compass] 配置未通过跨字段校验，已回落默认值（请检查 profile patch）：${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return resolveConfig({})
      }
    }
    // Stable reader: consumers capture this wrapper, never the current value.
    const configSource = (): ResolvedConfig => guardedConfig()
    const resolved = source()

    // 0.11.5/0.11.6 方案 A：挂载即预热 blank 真值图，带重试——sessionController
    // 可能晚于本插件挂载，单次 refresh 会静默 no-op 导致首帧闪现空白行；
    // warmBlankTruth 在预算内短间隔重试直到真值图填充（首帧即正确裁剪）。
    warmBlankTruth(ctx)

    // Live pricing cache: periodic fetch when priceSource is 'auto',
    // static config otherwise. Provided on the context so assess() and the
    // projection view share one resolved price. C1: the refresh wiring reads
    // cost.priceSource/urls/refreshHours ONCE here — those four fields take
    // effect after a restart (documented in the schema); everything else is live.
    const pricing = new PriceCache(staticPricing(resolved.cost.inputPricePerM, resolved.cost.cacheHitDiscount))
    ctx.provide('sessionHealthPricing', pricing)
    startPricingRefresh(ctx, resolved.cost, pricing)
    // Current model name for per-model prices ('' falls back to the doc's "*").
    const modelOf = (): string => {
      try {
        const sel = (ctx.get('agentDefaultModel') as { currentSelection(): { model: string } } | undefined)?.currentSelection()
        return sel?.model ?? ''
      } catch {
        return ''
      }
    }

    // Reactive badge data (optional child: headless assemblies without the
    // projection registry just lose the push path, not the plugin).
    // C1: projection.enabled is a registration-level fact — onChange re-judges
    // it (dispose the unit, or register it) instead of requiring a restart.
    // AUDIT C1-2: `projectionQueued` guarantees at most one pending inject —
    // without it, the async mount sequence (settings mounts → onChange while
    // sessionProjections is still absent) queued two inject children that both
    // registered on arrival, double-registering the unit and orphaning the
    // first disposer.
    let projectionDisposer: (() => void) | null = null
    let projectionQueued = false
    const syncProjectionUnit = (): void => {
      const want = source().projection.enabled
      if (want && projectionDisposer === null && !projectionQueued) {
        projectionQueued = true
        ctx.inject(['sessionProjections'], (projectionCtx) => {
          projectionQueued = false
          // Re-check at arrival: toggled off while pending, or another pending
          // child already registered (AUDIT C1-2 guard) → do nothing.
          if (!source().projection.enabled || projectionDisposer !== null) return
          projectionDisposer = projectionCtx.sessionProjections.register(sessionHealthProjectionDefinition(configSource, pricing, modelOf))
        })
      } else if (!want) {
        projectionQueued = false
        projectionDisposer?.()
        projectionDisposer = null
      }
    }
    syncProjectionUnit()
    // `projection.enabled` 是**注册级**事实：它决定投影单元挂不挂。0.2.0-rc.2
    // 之前靠 settings 的 onChange 钩子重判定；新契约没有该钩子，但 volatile
    // 机制自带通知——cordis-plugin-loader 推进单元后会 emit
    // `loader/volatile-update` 并带上变化的字段路径（见其
    // _commitVolatile 与 lib/types/index.d.ts:29）。不接这个事件，开关就只剩
    // 「重启才生效」，而配置页里明明写着它可改。
    ctx.on('loader/volatile-update', (paths) => {
      for (const path of paths) {
        if (path[0] === 'projection' && path[1] === 'enabled') { syncProjectionUnit(); return }
      }
    })

    // Model-callable self-check (optional child).
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(sessionHealthTool(toolCtx, configSource))
    })

    // User-initiated report (optional child).
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register(healthCommandDefinition(commandCtx, configSource))
    })

    // Multi-session overview panel data (optional child): same-origin RPC
    // route for the browser panel — bundle clients cannot mount a plugin
    // Remote, so browser↔host calls ride the webServer seam (imgdraw pattern).
    // ctx.inject waits for the service: bundles apply before webServer
    // activates at boot and ctx.get would silently return undefined.
    ctx.inject(['webServer'], (wsCtx) => {
      const webServer = (wsCtx as unknown as {
        webServer: { register(route: unknown): () => void }
      }).webServer
      const dispose = webServer.register({
        kind: 'exact',
        path: '/context-compass-rpc',
        handler: (req: IncomingMessage, res: ServerResponse) => handleOverviewRpc(req, res, wsCtx, configSource),
      })
      ctx.effect(() => () => { try { dispose() } catch { /* ignore */ } })
    })
  },
} satisfies {
  name: string
  Config: typeof Config
  apply(ctx: Context, config?: ConfigType): void
}
