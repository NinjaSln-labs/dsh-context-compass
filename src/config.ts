/**
 * dsh-context-compass — plugin configuration.
 *
 * Every threshold mirrors the community session-health skill's
 * two-dimensional continue-vs-new decision model, but as host-side defaults a
 * deployment can override. The exported schemastery `Config` documents the
 * shape for the Loader / settings UI; resolveConfig() defensively defaults so
 * partial configs (and tests) always yield a complete ResolvedConfig.
 */
import z from '@deepseek-ai/schemastery'

export interface ThresholdsConfig {
  /** Window-ratio floor of the "留意" (blue) tier. Default 0.3. */
  windowMid: number
  /** Window-ratio floor of the "留意/收尾" (yellow) tier. Default 0.5. */
  windowHigh: number
  /** Window-ratio floor of the "危险区" (red) tier. Default 0.8. */
  windowCritical: number
  /**
   * Billable-equivalent (cache-discounted) tokens per round that make the
   * economy dimension expensive. Default 50000. The effective floor is
   * max(economyTokenFloor, economyWindowRatio × contextWindow) when the
   * window is known — the absolute default was calibrated for ~128K-window
   * models, so it must scale up on larger windows or every session crosses
   * it at single-digit occupancy.
   */
  economyTokenFloor: number
  /**
   * Window-ratio component of the economy floor (see economyTokenFloor).
   * Default 0.3: on a 1M-window model the economy tier needs ~300K
   * billable-equivalent per round before it outranks the ratio tiers.
   */
  economyWindowRatio: number
  /** Remaining rounds at which economy cost accumulates. Default 10. */
  economyRoundFloor: number
  /** Message-count proxy for context bloat. Default 800. */
  messageCountProxy: number
  /**
   * Window-ratio component of the message-count proxy (A4): the effective
   * proxy is max(messageCountProxy, messageCountWindowRatio × contextWindow)
   * — 800 messages on a 128K window is not the same as on a 1M window.
   * Default 0.002: 128K → max(800, 256)=800, 1M → max(800, 2000)=2000.
   */
  messageCountWindowRatio: number
}

export interface ChecksConfig {
  git: { enabled: boolean; workspaceRoot?: string }
  handoff: { enabled: boolean; paths: string[] }
  sessionResume: { enabled: boolean }
  processes: { enabled: boolean }
  /** 知识库联动（解耦版）：探测 ctx.get('knowledge') 做跨会话回顾；未装则跳过。默认关。 */
  knowledge: { enabled: boolean }
}

export interface ProjectionConfig {
  /** Fold the sessionHealth projection unit (badge becomes reactive, no polling). Default true. */
  enabled: boolean
}

export interface CostConfig {
  /**
   * Cache-hit token price as a fraction of a full-price input token (e.g.
   * DeepSeek-style 0.1 = 1/10). Used for the per-round billable-equivalent
   * figure ("计费预期") in the projection, /compass, and the tool. Default 0.1.
   */
  cacheHitDiscount: number
  /**
   * Full-price input price in USD per 1M tokens (cache hits bill at
   * cacheHitDiscount × this). Static fallback AND the value used when
   * priceSource is 'static'. Default 0.28 (DeepSeek-class pricing).
   */
  inputPricePerM: number
  /**
   * 'auto' (default): periodically fetch the price from priceUrl and use the
   * last good document (falling back to the static values on failure).
   * 'static': never fetch; use inputPricePerM / cacheHitDiscount directly.
   */
  priceSource: 'auto' | 'static'
  /**
   * Primary JSON pricing document URL for priceSource 'auto'. Default: the
   * jsdelivr CDN mirror of the dsh-context-compass repo's pricing/deepseek.json —
   * GitHub raw is unreachable on many CN networks and a failed fetch silently
   * degrades the whole money display to static USD (no CNY).
   */
  priceUrl: string
  /**
   * Fallback URL tried in the same refresh cycle when the primary fails.
   * Default: the canonical GitHub raw location (covers CDN outages / stale
   * mirrors; whichever URL succeeds first wins).
   */
  priceFallbackUrl: string
  /** Refresh cadence for priceSource 'auto', in hours. Default 24. */
  priceRefreshHours: number
}

/** Untrusted plugin configuration after Loader normalization; every field optional. */
export interface Config {
  thresholds?: ThresholdsConfig
  checks?: ChecksConfig
  projection?: ProjectionConfig
  cost?: CostConfig
}

/** Schemastery schema: documents the shape for the Loader and settings UI.
 *  *** 单一权威（C1）***：此 schema 的 .default() 是配置默认值的唯一来源——
 *  settings 服务路径由它归一化；resolveConfig 的 ?? 回退仅服务无 settings
 *  回退与测试路径，改默认值时两处仍需同步。 */
/**
 * 0.2.0-rc.2 的 C1 接入：宿主 `SettingsForms` 只把 schema 里标了 `.volatile()`
 * 的字段暴露成可编辑表单（`volatileForm` / `isVolatilePath`，见
 * dsh-settings/lib/index.js:122/153），未标的字段在设置页根本不会出现，
 * 且 `write()` 会对无 volatile 字段的条目直接抛错。
 *
 * 标注口径与既有语义一一对应，��是新的分类：
 *   - volatile —— 本来就声明「改完即生效」的字段（阈值 8 / 检查项 6 /
 *     投影开关 / 计费显示 2），宿主表单改完由 onChange 路径重新判定；
 *   - 非 volatile —— 本来就声明「重启后生效」的计费源 4 项，保持原样。
 * `.volatile()` 是 schemastery 原生方法（宿主自有插件 71 处在用）。
 */
// 0.2.0-rc.2：`.volatile()` 字段的解析类型是 cosmokit 的 `Volatile<T>` 活体单元
// （有 `.get()`，无 `set()`——写入由宿主 SettingsForms 持有），不是裸值。故此处
// 交给 TS 推断条目类型，不再用 `z<Config>` 强行贴合旧的裸值接口；
// resolveConfig 通过 readVolatile 统一读法消化两种形态（单测仍喂裸值）。
export const Config = z.object({
  thresholds: z.object({
    windowMid: z.number().min(0).max(1).default(0.3).volatile(),
    windowHigh: z.number().min(0).max(1).default(0.5).volatile(),
    windowCritical: z.number().min(0).max(1).default(0.8).volatile(),
    economyTokenFloor: z.number().min(0).default(50000).volatile(),
    economyWindowRatio: z.number().min(0).max(1).default(0.3).volatile(),
    economyRoundFloor: z.number().min(0).default(10).volatile(),
    messageCountProxy: z.number().min(0).default(800).volatile(),
    messageCountWindowRatio: z.number().min(0).max(1).default(0.002).volatile(),
  }),
  checks: z.object({
    git: z.object({
      enabled: z.boolean().default(false).volatile(),
      workspaceRoot: z.string().volatile(),
    }),
    handoff: z.object({
      enabled: z.boolean().default(true).volatile(),
      /** User-named handoff documents; the concept is yours, the names are yours. */
      paths: z.array(z.string()).default([]).volatile(),
    }),
    sessionResume: z.object({ enabled: z.boolean().default(false).volatile() }),
    /** 运行中进程检测（dev server 等）是增量信号——默认关闭（对齐 DESIGN §4.6「关闭时跳过」）；/compass processes 或工具路径显式开启。 */
    processes: z.object({ enabled: z.boolean().default(false).volatile() }),
    knowledge: z.object({ enabled: z.boolean().default(false).volatile() }),
  }),
  projection: z.object({ enabled: z.boolean().default(true).volatile() }),
  cost: z.object({
    // 计费显示项：live 生效（readConfig 每次使用读当前值）。
    cacheHitDiscount: z.number().min(0).max(1).default(0.1).volatile(),
    inputPricePerM: z.number().min(0).default(0.28).volatile(),
    // 计费源 4 项：schema 文案已注明「重启后生效」，故不标 volatile。
    priceSource: z.union([z.const('auto'), z.const('static')]).default('auto'),
    priceUrl: z.string().default('https://cdn.jsdelivr.net/gh/NinjaSln-labs/dsh-context-compass@main/pricing/deepseek.json'),
    priceFallbackUrl: z.string().default('https://raw.githubusercontent.com/NinjaSln-labs/dsh-context-compass/main/pricing/deepseek.json'),
    priceRefreshHours: z.number().min(1).max(24 * 30).default(24),
  }),
})

export interface ResolvedConfig {
  thresholds: ThresholdsConfig
  checks: ChecksConfig
  projection: ProjectionConfig
  cost: CostConfig
}

/**
 * C1 live config source: a resolved snapshot (mount-time closure, the old
 * shape — tests and the no-settings fallback) or a thunk reading the current
 * authoritative value (the settings.installSection wiring). Consumers read
 * through readConfig() at USE time, so a thunk makes threshold changes live.
 */
export type ConfigSource = ResolvedConfig | (() => ResolvedConfig)

/** Read one ConfigSource at use time. */
export function readConfig(source: ConfigSource): ResolvedConfig {
  return typeof source === 'function' ? source() : source
}

/**
 * C1 cross-field validate (settings hooks.validate): the three capacity tiers
 * must ascend — a schema cannot express the relation, and a non-monotonic
 * ladder would make severity ordering silently wrong. Throwing refuses the
 * write that produced the value (settings-service semantics), so the caller
 * learns at update time instead of storing a broken ladder.
 */
export function validateThresholdLadder(value: ResolvedConfig): void {
  const t = value.thresholds
  if (!(t.windowMid < t.windowHigh && t.windowHigh < t.windowCritical)) {
    throw new Error(
      `阈值必须单调递增：windowMid(${t.windowMid}) < windowHigh(${t.windowHigh}) < windowCritical(${t.windowCritical})`,
    )
  }
}

/**
 * C1 hooks.validate — full-config cross-field + finiteness check (AUDIT C1-3).
 * Schemastery's range check is NaN-blind (`NaN > max` is false), so a
 * hand-edited YAML (`.nan`/`.inf`, which bypasses the settings-write JSON
 * shape check) could silently distort the economy/cost verdicts. Every numeric
 * config field must be finite; ladder monotonicity rides on top.
 */
export function validateConfig(value: ResolvedConfig): void {
  validateThresholdLadder(value)
  const numeric: Array<[string, number]> = [
    ['thresholds.windowMid', value.thresholds.windowMid],
    ['thresholds.windowHigh', value.thresholds.windowHigh],
    ['thresholds.windowCritical', value.thresholds.windowCritical],
    ['thresholds.economyTokenFloor', value.thresholds.economyTokenFloor],
    ['thresholds.economyWindowRatio', value.thresholds.economyWindowRatio],
    ['thresholds.economyRoundFloor', value.thresholds.economyRoundFloor],
    ['thresholds.messageCountProxy', value.thresholds.messageCountProxy],
    ['thresholds.messageCountWindowRatio', value.thresholds.messageCountWindowRatio],
    ['cost.cacheHitDiscount', value.cost.cacheHitDiscount],
    ['cost.inputPricePerM', value.cost.inputPricePerM],
    ['cost.priceRefreshHours', value.cost.priceRefreshHours],
  ]
  for (const [path, n] of numeric) {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`配置 ${path} 必须是非负有限数，收到 ${String(n)}`)
    }
  }
}

/** 双源警告（C1 后语义）：live 路径的默认值由 Config schema（settings 服务）
 *  归一化——schema 是唯一权威；此函数仅服务「无 settings 服务的回退」与
 *  纯函数测试路径，其 `??` 回退必须与 schema .default() 保持同步。 */
/**
 * 解包 0.2.0-rc.2 的 volatile 活体单元。
 *
 * 标了 `.volatile()` 的字段，解析出来是 cosmokit 的 `Volatile<T>`（只有
 * `get()`，写入由宿主 SettingsForms 持有）；未标 volatile 的字段仍是裸值。
 * 这里统一读法：宿主运行时读单元的当前快照，单测/旧路径喂裸值原样返回。
 * 每次调用都重新 get()——这正是「改配置 → 下次使用即生效」的活源语义，
 * 取代了 0.2.0 之前 settings 的 setSource 重绑定钩子。
 */
function live<T>(value: T | { get(): T } | undefined): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const thresholds: ThresholdsConfig = {
    windowMid: live(config.thresholds?.windowMid) ?? 0.3,
    windowHigh: live(config.thresholds?.windowHigh) ?? 0.5,
    windowCritical: live(config.thresholds?.windowCritical) ?? 0.8,
    economyTokenFloor: live(config.thresholds?.economyTokenFloor) ?? 50000,
    economyWindowRatio: live(config.thresholds?.economyWindowRatio) ?? 0.3,
    economyRoundFloor: live(config.thresholds?.economyRoundFloor) ?? 10,
    messageCountProxy: live(config.thresholds?.messageCountProxy) ?? 800,
    messageCountWindowRatio: live(config.thresholds?.messageCountWindowRatio) ?? 0.002,
  }
  // 这里的 `?? X` 兜底必须与上方 Config schema 的 `.default(X)` **逐项一致**。
  // 两份真源只改一边，schema 的新默认值就会被这里的旧字面量盖掉——而且不会有
  // 任何报错（resolveConfig 对残缺配置本就该静默兜底）。改任一侧都要改另一侧。
  const checks: ChecksConfig = {
    git: {
      enabled: live(config.checks?.git?.enabled) ?? false,
      workspaceRoot: config.checks?.git?.workspaceRoot,
    },
    handoff: {
      enabled: live(config.checks?.handoff?.enabled) ?? true,
      paths: live(config.checks?.handoff?.paths) ?? [],
    },
    sessionResume: { enabled: live(config.checks?.sessionResume?.enabled) ?? false },
    processes: { enabled: live(config.checks?.processes?.enabled) ?? false },
    knowledge: { enabled: live(config.checks?.knowledge?.enabled) ?? false },
  }
  const projection: ProjectionConfig = { enabled: live(config.projection?.enabled) ?? true }
  const cost: CostConfig = {
    cacheHitDiscount: live(config.cost?.cacheHitDiscount) ?? 0.1,
    inputPricePerM: live(config.cost?.inputPricePerM) ?? 0.28,
    priceSource: live(config.cost?.priceSource) ?? 'auto',
    priceUrl: live(config.cost?.priceUrl) ?? 'https://cdn.jsdelivr.net/gh/NinjaSln-labs/dsh-context-compass@main/pricing/deepseek.json',
    priceFallbackUrl: live(config.cost?.priceFallbackUrl) ?? 'https://raw.githubusercontent.com/NinjaSln-labs/dsh-context-compass/main/pricing/deepseek.json',
    priceRefreshHours: live(config.cost?.priceRefreshHours) ?? 24,
  }
  return { thresholds, checks, projection, cost }
}
