/**
 * dsh-context-compass — multi-session overview (panel data).
 *
 * Host side of the 上下文罗盘一览面板: one read-only snapshot of the
 * current workspace's top-level sessions for the browser panel
 * (`sidebar.footer.action` opens it, `shell.overlay` renders it).
 *
 * Scope mirrors the sidebar exactly: top-level sessions (subagent children
 * excluded) that are not archived (`workspaceRegistry.archivedSessionIds` —
 * the registry-global archive set every grouping surface hides).
 *
 * LATENCY: the panel must open fast. The two expensive reads — cold
 * projection loads and title folds (both read the session log) — are
 * handled so the first frame never waits on a log read:
 * - cold projection loads run in parallel and backfill in place
 * - titles come from the live in-memory fold or a short-TTL in-memory
 *   cache; cache misses return null this frame and a BACKGROUND fill
 *   (bound to the request's abort scope — once the panel closes the fill
 *   has no consumer left) populates the cache, so the panel's 5s refresh
 *   shows titles moments later
 *
 * Transport: same-origin JSON RPC (POST /context-compass-rpc, loopback-only),
 * the same pattern dsh-imgdraw established for bundle clients — a bundle
 * client cannot expose a plugin Remote, so browser↔host calls ride the
 * webServer route seam.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionActivity, SessionHealthProjection } from './types.ts'
import type { HealthReport } from './assess.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { assess } from './assess.ts'
import { readConfig, type ConfigSource, type ResolvedConfig } from './config.ts'
import { formatCompact, formatHitRate } from './util.ts'

/** One session row in the overview panel. */
export interface OverviewRow {
  id: string
  /** Best-known title; null when no title event exists yet (or still loading). */
  title: string | null
  /**
   * Real activity: `running` = the session's Agent lifecycle status is
   * `running` (actively processing a turn — the sidebar's 进行中 signal);
   * `loaded` = materialized in ctx.sessions but idle; `cold` = persisted
   * only. NOT the old `live` flag (that meant mere in-memory presence).
   */
  status: SessionActivity
  /** Session creation time (Unix epoch ms) — secondary sort key. */
  createdAt: number
  /** The health verdict; null when no projection value exists (cold + no cache row). */
  health: SessionHealthProjection | null
  /** Owning workspace (display title); null when the session is ungrouped. */
  workspace: { id: string; title: string } | null
}

// OV-5 治愈：排序规则收敛到共享单源模块（src/overview-sort.ts），host/client
// 同源。import 供 buildOverview 内部调用，同时 re-export 保持 lib/overview.js
// 的公共出口（rankOf / sortOverviewRows）不变——测试与 index.ts 引用路径无需改动。
import { rankOf, sortOverviewRows, type SortableOverviewRow } from './overview-sort.ts'
export { rankOf, sortOverviewRows, type SortableOverviewRow }

/** Loose face of the sessionQuery service (only the parts overview needs). */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{
    header: { id: string; createdAt?: number; origin?: string; cwd?: string }
    live?: boolean
    persisted?: boolean
  }>>
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Array<{
    sessionId: string
    status: 'fulfilled' | 'rejected'
    value?: { title?: { title: string } }
  }>>
}

/** Loose face of the in-memory session store (live sessions). */
interface SessionsStoreLike {
  get(id: string): { header?: { id?: string } } | undefined
}

/**
 * Short-TTL in-memory title cache. Title folds read the whole session log,
 * which is the dominant cost of an overview request; the cache lets the
 * first frame skip every log read and the background fill (see below)
 * populate it seconds later. TTL keeps renames/misses fresh on the 5s
 * panel refresh cadence.
 */
const titleCache = new Map<string, { title: string; at: number }>()
const TITLE_TTL_MS = 60_000

/**
 * Confirmed-blank sessions (sidebar "blank" cut): a cold session whose log was
 * folded for a title and found none — i.e. a header-only (truly empty) log.
 * Distinct from titleCache which only records sessions WITH a title. Rows are
 * filtered on frames AFTER the background fill confirms the absence, so the
 * first frame (fill still pending) never hides a session pre-emptively.
 */
const blankCache = new Map<string, number /* at */>()
const BLANK_TTL_MS = 60_000

/**
 * Session-visibility cut fed by the host aggregator (sessionController.list):
 * 0.11.5 方案 A. The sidebar renders exactly this list — every row already
 * carries the sessionListMetadata.blank projection truth
 * (blank = never had a turn/start event), so cutting cold blank rows from it
 * makes the FIRST frame correct: no async fill confirmation, no 60s-TTL
 * re-appearance window. The map refreshes in the background after each frame
 * (stale-while-revalidate) and NEVER blocks or fails the panel: an absent or
 * throwing controller simply leaves the map empty and the legacy title-proxy
 * path (scheduleTitleFill + blankCache) keeps working.
 */
const blankTruth = new Map<string, boolean>()
let blankTruthFetching = false
/** Padding around the sidebar's own refresh cadence so panel polls mostly hit cache. */
const BLANK_TRUTH_TTL_MS = 4_000
/** Last refresh attempt time (SWR pacing; module state shared with refreshBlankTruth). */
const blankTruthAtRef = { at: 0 }

/**
 * SessionListValue 的真实契约（2026-09-03 事故根源）：宿主
 * `sessionController.list(_request, signal)` 返回 `{ items: SessionListValue[] }`
 * （包裹对象），不是裸数组。此处兼容两种形态防御性读取。
 */
interface SessionListSummaryLike {
  sessionId?: unknown
  blank?: unknown
}

/** 宿主 sessionController.list 的松散面（真契约：list({cursor?}, signal) → {items}）。 */
interface SessionControllerLike {
  list?(_request?: { cursor?: string }, signal?: AbortSignal): Promise<unknown>
}

/** Kick one background blank-truth refresh; returns the in-flight promise (dedup'd). */
function fetchBlankTruth(controller: unknown): Promise<void> {
  if (blankTruthFetching) return Promise.resolve()
  const list = (controller as SessionControllerLike | undefined)?.list
  if (typeof list !== 'function') return Promise.resolve()
  blankTruthFetching = true
  const promise = (async () => {
    try {
      const signal = new AbortController().signal
      const result = await list.call(controller, {}, signal)
      // 防御兼容：宿主真契约返回 { items: [...] }；兼收裸数组形态（兼容 stub/旧实现）。
      const items = (result as { items?: unknown } | null | undefined)?.items
      const rows = Array.isArray(items)
        ? (items as SessionListSummaryLike[])
        : Array.isArray(result)
          ? (result as SessionListSummaryLike[])
          : null
      if (rows === null) return
      const next = new Map<string, boolean>()
      for (const row of rows) {
        if (typeof row?.sessionId === 'string' && typeof row.blank === 'boolean') {
          next.set(row.sessionId, row.blank)
        }
      }
      // 只整体替换非空结果（与 listCache 同一防抖动原则）：空结果可能是网关
      // 瞬态，不覆盖上一份真值；真「全部删空」由连续空采信路径兜底（listCache）。
      if (next.size > 0) {
        blankTruth.clear()
        for (const [k, v] of next) blankTruth.set(k, v)
      }
    } catch { /* keep previous truth; next frame retries */ }
    finally { blankTruthFetching = false }
  })()
  void promise
  return promise
}

/**
 * Refresh the blank-truth map from the host aggregator. Fire-and-forget at
 * plugin mount (index.ts) — warms the map so a panel opened later gets a
 * correct FIRST frame; request frames keep SWR-refreshing it every
 * BLANK_TRUTH_TTL_MS. An absent/throwing controller resolves harmlessly and
 * the legacy title-proxy path stays in charge.
 */
export function refreshBlankTruth(ctx: Context): Promise<void> {
  const controller = ctx.get('sessionController')
  blankTruthAtRef.at = Date.now()
  return fetchBlankTruth(controller)
}

/**
 * Mount-time blank-truth warmup with retry. `sessionController` may not be
 * mounted when this plugin applies (composition order), so a single
 * refreshBlankTruth can silently no-op and the FIRST panel frame would flash
 * blank rows (the very bug 0.11.5 was meant to kill). This retries on a short
 * cadence until the truth map is populated or the budget is exhausted, so a
 * panel opened after boot gets a correct first frame. Fire-and-forget.
 */
export function warmBlankTruth(ctx: Context, budgetMs = 20_000, intervalMs = 1_500): void {
  const started = Date.now()
  const attempt = (): void => {
    if (blankTruth.size > 0) return // populated — done
    void refreshBlankTruth(ctx)
    if (blankTruth.size > 0) return
    if (Date.now() - started >= budgetMs) return // give up quietly
    setTimeout(attempt, intervalMs)
  }
  attempt()
}

/** Forget the caches (tests / plugin re-apply). */
export function clearTitleCache(): void {
  titleCache.clear()
  blankCache.clear()
  blankTruth.clear()
  blankTruthFetching = false
}

/**
 * Background title fill: read the batch and populate the cache. The fill is
 * deliberately bound to the REQUEST's signal (not a fresh one): once the
 * request is aborted (panel closed / component unmounted) the fill has no
 * consumer left, so cancelling it avoids pointless log reads. Failures stay
 * silent — the next refresh retries. Fire-and-forget.
 */
function scheduleTitleFill(ctx: Context, ids: string[], fillSignal: AbortSignal): void {
  if (ids.length === 0) return
  const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (sessionQuery?.readTitleSnapshots === undefined) return
  const controller = new AbortController()
  fillSignal.addEventListener('abort', () => controller.abort(), { once: true })
  const promise = (async () => {
    try {
      const observations = await sessionQuery.readTitleSnapshots(ids, controller.signal)
      const now = Date.now()
      for (const o of observations) {
        if (o.status !== 'fulfilled') continue
        const t = o.value?.title?.title
        if (typeof t === 'string' && t !== '') {
          titleCache.set(o.sessionId, { title: t, at: now })
        } else {
          // Confirmed no title: the fold read this session's log and found no
          // title event. A cold session that will never have a title is the
          // sidebar's "blank" cut (truly empty sessions — a header-only log).
          // Record it so a LATER frame can hide it; THIS frame already showed
          // it with title null while the fill was pending.
          blankCache.set(o.sessionId, now)
        }
      }
    } catch { /* next refresh retries */ }
  })()
  void promise
}

/**
 * Cold-load cache: result-value cache + in-flight dedup, NEVER awaited on the
 * request path.
 *
 * 0.1.1 起 `sessionProjectionCache.coldSnapshot` 是重操作（cached rows +
 * persistence readFrom tail + registry refold + fail-soft write-back）。本面板
 * 的首帧预算是 200ms——cold load 一律后台化：
 * - 同步读：TTL 内的已解析结果直接进本帧（零等待）；
 * - miss → 后台发起（fire-and-forget，带 in-flight 去重与单帧新增上限），
 *   完成后回填缓存；该行本帧保持 `health: null`，由面板 5s 轮询自然补齐。
 * - 缓存 Promise 不携带单次请求的 AbortSignal（一次请求的 abort 不能污染共享
 *   结果），用独立超时兜底防永久挂起。
 */
const coldCache = new Map<string, { value: SessionHealthProjection | null; at: number }>()
const coldInFlight = new Map<string, Promise<void>>()
const COLD_TTL_MS = 60_000
const COLD_MAX_NEW = 4
const COLD_LOAD_TIMEOUT_MS = 20_000

/** 测试专用：清空模块级缓存（listSessions / cold load / blank truth），隔离用例间的 stub 状态。 */
export function __resetOverviewCachesForTests(): void {
  listCache = { rows: null, at: 0 }
  listInFlight.clear()
  coldCache.clear()
  coldInFlight.clear()
  titleCache.clear()
  blankTruth.clear()
  blankTruthFetching = false
}

/**
 * listSessions 结果缓存（6s TTL——略大于面板 5s 轮询，保证轮询帧大多命中缓存）+ 在途去重。空/异常结果不覆盖已有缓存。
 * 见 buildOverview 内注释——listSessions 是本 RPC 时延的全部来源。
 */
interface ListRowRec { header: { id: string; createdAt?: number; origin?: string; cwd?: string }; live?: boolean; persisted?: boolean }
let listCache: { rows: ListRowRec[] | null; at: number } = { rows: null, at: 0 }
const listInFlight = new Map<string, Promise<unknown>>()
const LIST_TTL_MS = 6_000
/**
 * Consecutive empty listSessions results (AUDIT OV-1): a single empty read is
 * treated as jitter and ignored, but TWO in a row are accepted as a legitimate
 * "all sessions deleted" — without this the ghost list could never heal.
 */
let listEmptyStreak = 0
/** True when this result may overwrite the cache (non-empty, or 2nd empty in a row). */
function listResultUsable(r: unknown): boolean {
  if (!Array.isArray(r)) return false
  if (r.length > 0) {
    listEmptyStreak = 0
    return true
  }
  listEmptyStreak += 1
  return listEmptyStreak >= 2
}

/**
 * Kick off one background cold load for `id`; on completion the parsed value
 * (or null) lands in {@link coldCache}. Never throws; never rejects.
 */
function scheduleColdLoad(
  id: string,
  run: () => Promise<{ values?: Record<string, unknown> }>,
): void {
  if (coldInFlight.has(id)) return
  const done = new Promise<void>(resolve => {
    const t = setTimeout(() => resolve(), COLD_LOAD_TIMEOUT_MS)
    try {
      run()
        .then(snap => {
          const value = (snap?.values?.sessionHealth as SessionHealthProjection | undefined) ?? null
          coldCache.set(id, { value: value !== undefined && value !== null ? value : null, at: Date.now() })
        })
        .catch(() => coldCache.set(id, { value: null, at: Date.now() }))
        .finally(() => clearTimeout(t))
    } catch {
      clearTimeout(t)
      coldCache.set(id, { value: null, at: Date.now() })
    }
  })
  coldInFlight.set(id, done)
  void done.finally(() => { coldInFlight.delete(id) })
}

/**
 * Build the overview rows: top-level (non-subagent), non-archived sessions.
 * Never throws on a single bad session — per-record failures degrade to
 * `health: null` / `title: null` so one broken record cannot blank the whole
 * panel. Returns [] when the sessionQuery service is absent (headless
 * assemblies keep working).
 *
 * First-frame budget is 200ms: the ONLY await on this path is
 * `listSessions`; every cold projection load runs in the background and its
 * row simply reads `health: null` this frame (the panel's 5s refresh picks
 * the backfilled value up).
 */
export async function buildOverview(ctx: Context, signal: AbortSignal): Promise<{ rows: OverviewRow[]; elapsed: { listMs: number; rowsMs: number; totalMs: number } }> {
  const t0 = Date.now()
  const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (sessionQuery === undefined) return { rows: [], elapsed: { listMs: 0, rowsMs: 0, totalMs: 0 } }

  // listSessions 结果缓存（6s TTL + in-flight 去重 + 空结果保护）。
  // 实测（2026-08-22，dsh 0.1.1-rc.1）：listSessions 本身 0.3s～11.2s 剧烈波动
  // 且偶尔返回空——它是本 RPC 全部时延的来源（rows 构建仅 ~20ms）。面板 5s 轮询
  // 不需要每帧都打真查询：TTL 内复用上一份列表；并发帧共享同一次在途调用；
  // 单次空/异常不覆盖缓存（防抖动），连续两次空采信清空（自愈幽灵列表）。
  type ListRows = ListRowRec[]
  let records: ListRows
  const fresh = listCache.rows !== null && t0 - listCache.at < LIST_TTL_MS
  if (fresh || listCache.rows !== null) {
    // 命中缓存（TTL 内）或有过期值（stale-while-revalidate）：立即返回，
    // 过期的同时后台刷新——任何帧都不等 harness 的慢查询（rc.2 实测抖到 5.7s）。
    records = listCache.rows as ListRowRec[]
    var listMs = 0
    if (!fresh && !listInFlight.has('list')) {
      // AUDIT OV-7: the background refresh must NOT ride the requesting frame's
      // signal — the frame can be aborted (panel closed) mid-flight, and the
      // in-flight refresh is SHARED: aborting it starves every other frame that
      // was waiting on the same promise. An independent controller lets the
      // refresh finish (and populate the cache) no matter what happens to the
      // frame that kicked it off.
      const bgSignal = new AbortController().signal
      const bg = (async () => {
        try {
          const r = await sessionQuery.listSessions(bgSignal)
          if (listResultUsable(r)) listCache = { rows: r, at: Date.now() }
        } catch { /* 保留旧值 */ }
      })()
      listInFlight.set('list', bg)
      void bg.finally(() => { listInFlight.delete('list') })
    }
  } else {
    // 冷启动第一帧（完全无缓存）：唯一真正等待 listSessions 的路径。
    let inflight = listInFlight.get('list')
    if (inflight === undefined) {
      const thisSignal = signal
      inflight = (async () => {
        try {
          const r = await sessionQuery.listSessions(thisSignal)
          // 单次空/异常保留旧值（防一次抖动清空面板）；连续两次空采信清空（AUDIT OV-1）。
          if (listResultUsable(r)) listCache = { rows: r, at: Date.now() }
          return Array.isArray(r) ? r : []
        } catch {
          return listCache.rows ?? []
        }
      })()
      listInFlight.set('list', inflight)
      void inflight.finally(() => { listInFlight.delete('list') })
    }
    records = (await inflight) as ListRows
    listMs = Date.now() - t0
  }
  if (!Array.isArray(records) || records.length === 0) return { rows: [], elapsed: { listMs, rowsMs: 0, totalMs: Date.now() - t0 } }

  // Archived sessions are hidden from every sidebar grouping surface; the
  // panel mirrors that (workspace accounting keeps them, visibility drops).
  const workspaceRegistry = ctx.get('workspaceRegistry') as
    | {
        archivedSessionIds?: readonly string[]
        list?(): Array<{ id: string; path?: string; title?: string; sessionIds?: readonly string[] }>
      }
    | undefined
  let archived: ReadonlySet<string> | null = null
  try {
    const ids = workspaceRegistry?.archivedSessionIds
    if (Array.isArray(ids)) archived = new Set(ids)
  } catch { /* no archive cut */ }
  // Session → workspace display map (title ?? path basename). A session can
  // appear in several workspace accounts in principle; first match wins.
  const workspaceBySession = new Map<string, { id: string; title: string }>()
  try {
    for (const w of workspaceRegistry?.list?.() ?? []) {
      const title = (typeof w.title === 'string' && w.title !== '')
        ? w.title
        : (w.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? w.id
      for (const sid of w.sessionIds ?? []) {
        if (!workspaceBySession.has(sid)) workspaceBySession.set(sid, { id: w.id, title })
      }
    }
  } catch { /* rows stay ungrouped */ }

  // 0.11.5 方案 A：blank 真值来自宿主聚合层（sessionController.list —— 侧边栏
  // 渲染的就是这份列表，每行带 sessionListMetadata.blank 投影）。挂载时已预热
  // （refreshBlankTruth），请求帧按 TTL 节流地 SWR 后台刷新；首帧即有真值可用。
  // 缺席/抛错时地图为空，行管线退回 0.11.4 的标题代理路径。
  const sessionController = ctx.get('sessionController') as unknown
  const blankTruthFresh = blankTruth.size > 0
  if (Date.now() - blankTruthAtRef.at >= BLANK_TRUTH_TTL_MS) {
    blankTruthAtRef.at = Date.now()
    void fetchBlankTruth(sessionController)
  }

  const sessionsStore = ctx.get('sessions') as SessionsStoreLike | undefined
  const projections = ctx.get('sessionProjections') as
    | { snapshot(session: unknown): { values?: Record<string, unknown> } }
    | undefined
  const cache = ctx.get('sessionProjectionCache') as
    | {
        cachedSnapshot(meta: { id: string }): { values?: Record<string, unknown> } | undefined
        coldSnapshot?(id: string, signal?: AbortSignal): Promise<{ values?: Record<string, unknown> }>
      }
    | undefined
  const titleSvc = ctx.get('sessionTitle') as
    | { get(session: unknown): { title?: string } | undefined }
    | undefined
  // Real activity signal: the Agent registry. `agents.get(id)?.status ===
  // 'running'` is the genuine "actively processing" state (the sidebar's
  // 进行中 marker). Absent service (headless assembly) → never report
  // running; fall back to loaded/cold from the session-store presence.
  const agents = ctx.get('agents') as
    | { get(id: string): { status?: 'idle' | 'running' } | undefined }
    | undefined

  const rows: OverviewRow[] = []
  // Cold projection loads NEVER run on this path: misses are scheduled in the
  // background (scheduleColdLoad) and the panel's 5s refresh picks the values
  // up. First-frame budget is listSessions + synchronous reads only.
  let coldLoadsNew = 0
  // Title cache misses: filled in the background, never awaited this frame.
  const titleMisses: string[] = []
  const now = Date.now()

  for (const rec of records) {
    const id = rec.header?.id
    if (typeof id !== 'string' || id === '') continue
    // The sidebar lists top-level sessions only: subagent children and
    // archived sessions stay out.
    if (rec.header.origin === 'subagent') continue
    if (archived !== null && archived.has(id)) continue
    // Host list() mirror: cold records without header.cwd never enter the
    // sidebar's data source (ApiSessionList.list skips them) — cut the same
    // rows here. Live records are unaffected (summaryFor always includes them).
    if (rec.live !== true && rec.persisted === true && rec.header.cwd === undefined) continue
    // Blank truth cut (方案 A): a session whose projection says it never had a
    // turn/start is the sidebar's blank row — hidden for every non-current
    // session. Cut COLD rows only: a live row's blank flag flips the moment a
    // turn starts, while this map is background-refreshed — cutting live rows
    // would hide them on stale truth. (The sidebar's remaining blank row is
    // the provisional current-session placeholder; the compass lists real
    // sessions and deliberately does not mirror it.)
    if (blankTruthFresh && rec.live !== true && blankTruth.get(id) === true) continue
    // Workspace mapping: the sidebar's groupByWorkspace shows sessions outside
    // every workspace in its 未分组 bucket — stray rows STAY (workspace: null),
    // mirroring that bucket. (0.11.3 dropped strays — a wrong mirror, fixed in
    // 0.11.5.) Without a registry (headless), rows are ungrouped as before.
    const ws = workspaceBySession.get(id)
    const createdAt = typeof rec.header.createdAt === 'number' ? rec.header.createdAt : 0

    // Health value: live projection snapshot first, then the persisted cache
    // (sync read), then an async cold load for a persisted session.
    let health: SessionHealthProjection | null = null
    const liveSession = rec.live === true ? sessionsStore?.get(id) : undefined
    if (liveSession !== undefined && projections !== undefined) {
      try {
        const values = projections.snapshot(liveSession).values ?? {}
        const value = values.sessionHealth as SessionHealthProjection | undefined
        if (value !== undefined && value !== null) health = value
      } catch { /* fall through to the cache */ }
    }
    if (health === null && cache !== undefined) {
      try {
        const snap = cache.cachedSnapshot(rec.header)
        const value = snap?.values?.sessionHealth as SessionHealthProjection | undefined
        if (value !== undefined && value !== null) health = value
      } catch { /* fall through to cold load */ }
    }
    if (health === null && cache?.coldSnapshot !== undefined && rec.persisted === true) {
      const cached = coldCache.get(id)
      if (cached !== undefined && now - cached.at < COLD_TTL_MS) {
        // TTL 内的已解析结果：直接进本帧（零等待、零 IO）。
        if (cached.value !== null) health = cached.value
      } else if (coldLoadsNew < COLD_MAX_NEW) {
        // miss：后台发起（fire-and-forget），本帧保持 health=null，5s 轮询补齐。
        coldLoadsNew++
        const coldSnapshot = cache.coldSnapshot.bind(cache)
        scheduleColdLoad(id, () => coldSnapshot(id))
        // 顺手清理过期条目，防 Map 无界增长（会话数有限，O(n) 可忽略）。
        if (coldCache.size > 64) {
          for (const [k, v] of coldCache) if (now - v.at >= COLD_TTL_MS) coldCache.delete(k)
        }
      }
      // 超过单帧新增上限：本轮该行保持 health=null，后续帧补齐。
    }

    // Title: live log-backed fold (in-memory, fast) first, then the cache.
    // A miss returns null THIS frame and schedules a background fill — the
    // panel's 5s refresh picks the title up without ever blocking first
    // paint on a log read.
    let title: string | null = null
    if (liveSession !== undefined && titleSvc !== undefined) {
      try { title = titleSvc.get(liveSession)?.title ?? null } catch { /* cache below */ }
    }
    if (title === null) {
      const cached = titleCache.get(id)
      if (cached !== undefined && now - cached.at < TITLE_TTL_MS) {
        title = cached.title
      } else {
        titleMisses.push(id)
      }
    }

    // Activity: running agent > loaded (in memory, idle) > cold (persisted).
    // `agents.get` is a registry lookup, cheap per row; guarded per session.
    let status: SessionActivity = rec.live === true ? 'loaded' : 'cold'
    if (agents !== undefined) {
      try {
        if (agents.get(id)?.status === 'running') status = 'running'
      } catch { /* fall back to loaded/cold */ }
    }

    // Blank (truly empty) cold sessions are hidden from the sidebar
    // (`session.seq === 0` / projection `sessionListMetadata.blank`). Mirror
    // that cut via the background title fold: a session confirmed to have no
    // title event is a header-only log. The confirmation lands on a LATER
    // frame (blankCache populated after the async fill), so a first-frame
    // session — title still pending — is never hidden pre-emptively.
    const blankAt = blankCache.get(id)
    if (status === 'cold' && blankAt !== undefined && now - blankAt < BLANK_TTL_MS) continue

    rows.push({
      id,
      title,
      status,
      createdAt,
      health,
      workspace: ws ?? null,
    })
  }

  // Background title fill (never awaited; fresh signal, own abort scope).
  if (titleMisses.length > 0) scheduleTitleFill(ctx, titleMisses, signal)

  // 分段计时（诊断用，随 RPC result.elapsed 暴露）：listMs = listSessions；
  // rowsMs = 行构建（同步读 live snapshot / cachedSnapshot / 缓存）。
  const rowsMs = Date.now() - t0 - listMs
  return { rows: sortOverviewRows(rows), elapsed: { listMs, rowsMs, totalMs: Date.now() - t0 } }
}

/** Loopback-only guard for the RPC route (the panel data stays on the machine). */
function isLoopback(req: IncomingMessage): boolean {
  const addr = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  // Fail-closed (AUDIT OV-2): an unreadable peer address refuses the request
  // instead of silently dropping the loopback guard.
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  // Host check (AUDIT OV-3): DNS rebinding (evil.com → 127.0.0.1) sends a
  // foreign Host header — only loopback hostnames may talk to the RPC.
  const host = String(req.headers?.host ?? '')
  return /^(127\.0\.0\.1|\[::1\]|::1|localhost)(:\d+)?$/i.test(host)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** RPC body 上限：请求极小（method + sessionId），16KB 防御恶意大 body OOM。 */
const MAX_BODY_BYTES = 16 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** RPC request shape from the browser panel. */
interface RpcCall {
  method?: string
  sessionId?: string
}

/** 摘要文本的最大长度（防御超长报告）。 */
const SUMMARY_MAX_LEN = 2000

/**
 * Build the copy-ready handoff summary for one session — plain text, one
 * line per fact, no markdown. Consumed by the badge tooltip's 复制交接摘要
 * action (B3). Uses the same read-only assess() core so the git / handoff
 * checklist state is real, not invented.
 */
export function buildHandoffSummary(report: HealthReport): string {
  const s = report.signals
  const h = report.handoff
  const pct = s.ratio !== null ? Math.min(Math.round(s.ratio * 100), 100) : null
  const lines: string[] = ['上下文罗盘摘要', '—']
  lines.push(`健康度：${report.severity}（${report.summary}）`)
  if (typeof s.turns === 'number') {
    lines.push(`会话规模：${s.turns} 轮 / ${(s.userMessages ?? 0) + (s.assistantMessages ?? 0)} 条消息`)
  }
  if (s.total !== null) {
    lines.push(`每轮输入：约 ${formatCompact(s.total)} token${pct !== null ? `（窗口 ${pct}%）` : ''}`)
  }
  if (typeof s.cacheHitRate === 'number') {
    lines.push(`缓存命中：${formatHitRate(s.cacheHitRate)}`)
  }
  if (typeof s.compactions === 'number' && s.compactions > 0) {
    // isFinite：与 tool.ts/command.ts 的 compactionRatio 守卫对齐（纵深防御）。
    const ratio = typeof s.compactionRatio === 'number' && Number.isFinite(s.compactionRatio)
      ? `（上次压缩比例 ≈ ${Math.round(s.compactionRatio * 100)}%）`
      : ''
    lines.push(`已压缩：${s.compactions} 次${ratio}`)
  }
  if (h.uncommittedCount !== null) lines.push(`未提交变更：${h.uncommittedCount} 个`)
  if (h.hasHandoff !== null) lines.push(`交接文档：${h.hasHandoff ? '已就位' : '未找到'}`)
  if (h.lastCommit !== null) lines.push(`最新 commit：${h.lastCommit}`)
  // push 状态（ahead/behind）也是交接清单的真实部分——未 push 的提交在切换
  // 前需推送，B3 规格要求「git 状态」。
  if (h.branchLine !== null) lines.push(`分支：${h.branchLine}`)
  lines.push(`时间：${new Date().toISOString()}`)
  return lines.join('\n').slice(0, SUMMARY_MAX_LEN)
}

/**
 * Full HTTP handler for POST /context-compass-rpc. Methods:
 *   { method: 'overview' } → { ok: true, result: { sessions: OverviewRow[] } }
 *   { method: 'summary', sessionId } → { ok: true, result: { text } }
 * Loopback-only (panel data is private to the machine); 405 on non-POST,
 * 400 on malformed JSON, 403 on non-loopback peers, 500 on service failure.
 */
export async function handleOverviewRpc(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  configSource: ConfigSource,
): Promise<void> {
  // C1: read the live source once per request — thresholds/sorting reflect the
  // current config without a restart. (AUDIT C1-5: inside the try so a torn
  // namespace cannot escape the handler without a 500.)
  let config: ResolvedConfig
  try {
    config = readConfig(configSource)
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' })
    return
  }
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  let call: RpcCall
  try {
    call = JSON.parse(await readBody(req)) as RpcCall
  } catch (e) {
    // body 超限 → 413；其余（非法 JSON）→ 400。
    const status = e instanceof Error && (e as { status?: number }).status === 413 ? 413 : 400
    sendJson(res, status, { ok: false, error: status === 413 ? 'request body too large' : 'invalid json' })
    return
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    if (call.method === 'overview') {
      const { rows: sessions, elapsed } = await buildOverview(ctx, controller.signal)
      sendJson(res, 200, { ok: true, result: { sessions, elapsed } })
      return
    }
    if (call.method === 'summary') {
      const sessionId = call.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'sessionId required' })
        return
      }
      const sessions = ctx.get('sessions') as { get(id: string): unknown } | undefined
      const agents = ctx.get('agents') as { get(id: string): { id: string } | undefined } | undefined
      const session = sessions?.get(sessionId) as Session | undefined
      const agent = agents?.get(sessionId)
      if (session === undefined || agent === undefined) {
        sendJson(res, 404, { ok: false, error: 'session not found' })
        return
      }
      // 用插件挂载时的真实配置（用户可覆盖阈值/检查项），不是默认值。
      const report = await assess(ctx, session, agent.id, controller.signal, config)
      sendJson(res, 200, { ok: true, result: { text: buildHandoffSummary(report) } })
      return
    }
    sendJson(res, 400, { ok: false, error: `unknown method: ${String(call.method)}` })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
  } finally {
    clearTimeout(timeout)
  }
}
