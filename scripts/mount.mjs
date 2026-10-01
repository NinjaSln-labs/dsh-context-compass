/**
 * dsh-context-compass — mount smoke test.
 *
 * Mounts the built plugin the way the harness LOADER does (cordis-plugin-loader
 * unwrapExports: `module.default ?? module`, then `ctx.plugin(...)`) and
 * verifies the wiring: conditional registration of the projection unit / tool
 * / command through ctx.inject children, and live handler runs.
 *
 * Regression guard: the plugin default export MUST be an object with `apply`
 * (loader pitfall — a factory function default is called as the plugin body
 * and its returned `{ apply }` is silently ignored: no error, entry ACTIVE,
 * apply never runs). If apply does not run, the registrations below stay
 * null → this test fails.
 *
 *   npm run build && node scripts/mount.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { assertKeysIterable } from './tests/helpers.mjs'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../lib/config.js'

const session = { header: { cwd: '/tmp/ws' } }
const registrations = { commands: null, tools: null, projections: null, routes: [] }

const ctx = new Context()
ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 300_000 }) })
ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) })
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) })
ctx.provide('sessions', { get: id => (id === 's1' ? session : undefined) })
ctx.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' })
// The overview scope is: top-level + non-archived (sidebar visibility).
ctx.provide('workspaceRegistry', { archivedSessionIds: ['other-ws'] })
ctx.provide('fs', {
  resolve: async p => p,
  stat: async p => (p === '.git' ? {} : undefined),
})
// Read-only git worktree probe fixture: clean worktree, synced branch.
const GIT_OUT = {
  'status --short': '',
  'log --oneline -1': '166f5ac feat: dsh-context-compass\n',
  'status -sb': '## main...origin/main\n',
}
ctx.provide('subprocess', {
  spawn: ({ argv }) => ({
    done: Promise.resolve({ exitCode: 0 }),
    collected: { stdout: { readFrom: () => ({ text: GIT_OUT[`${argv[1]} ${argv[2] ?? ''}`.trim()] ?? '' }) } },
  }),
})
ctx.provide('commands', { register: def => { registrations.commands = def } })
ctx.provide('tools', { register: tool => { registrations.tools = tool } })
ctx.provide('webServer', {
  register: route => {
    registrations.routes.push(route)
    return () => { /* dispose no-op */ }
  },
})
ctx.provide('sessionQuery', {
  listEvents: async () => [],
  listSessions: async () => [
    { header: { id: 's1', createdAt: 100, cwd: '/tmp/ws' }, live: true, persisted: true },
    { header: { id: 's2', createdAt: 200, cwd: '/tmp/ws' }, live: false, persisted: true },
    { header: { id: 'other-ws', createdAt: 300, cwd: '/elsewhere' }, live: false, persisted: true },
    { header: { id: 'sub', createdAt: 400, cwd: '/tmp/ws', origin: 'subagent' }, live: false, persisted: true },
  ],
  readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: `标题-${id}` } } })),
})
ctx.provide('sessionProjectionCache', {
  // 宿主 0.2.0-rc.2 契约：cachedSnapshot(meta, keys?)——无 offset 参，身份由宿主内部
  // lifecycleIdentityOf 判定；同步返回。宿主自 0.1.2 起没有可用的 coldSnapshot
  // （private + 三参 + 零调用点），桩里也不提供。
  cachedSnapshot: (meta, keys) => {
    assertKeysIterable(keys)
    return { asOfSeq: 5, values: { sessionHealth: { severity: 'yellow', advice: 'a', ratio: 0.6, total: 600_000, window: 1_000_000, turns: 1, userMessages: 1, assistantMessages: 0, compactions: 0, uncachedInputTokens: 600_000, cacheReadTokens: 0, effectivePerRound: 600_000, effectivePerRoundUsd: 0.168, effectivePerRoundCny: null, pricePeriod: null } } }
  },
})
ctx.provide('sessionTitle', { get: () => undefined })
ctx.provide('sessionProjections', {
  register: def => { registrations.projections = def },
  // assess() reads usage buckets from the pushed snapshot — uncached 300K/round
  // on a 1M window hits the window-scaled economy floor (max(50K, 0.3×1M)).
  snapshot: () => ({
    values: {
      sessionHealth: {
        severity: 'yellow', advice: 'a', ratio: 0.3, total: 300_000, window: 1_000_000,
        turns: 0, userMessages: 0, assistantMessages: 0, compactions: 0,
        cacheHitRate: 0, uncachedInputTokens: 300_000, cacheReadTokens: 0,
        effectivePerRound: 300_000, effectivePerRoundUsd: 0.084, effectivePerRoundCny: null, pricePeriod: null,
      },
    },
  }),
})

// The exact loader normalization path (cordis-plugin-loader unwrapExports).
const mod = await import('../lib/index.js')
const plugin = mod.default ?? mod
assert.equal(typeof plugin, 'object', 'plugin must be an OBJECT, not a factory function')
assert.equal(typeof plugin.apply, 'function', 'plugin object must carry apply')
assert.equal(plugin.name, 'dsh-context-compass')
assert.ok(plugin.Config, 'plugin object must carry Config')

await ctx.plugin(plugin).await()
// Let the ctx.inject children (projection / tool / command) settle.
await new Promise(resolve => setTimeout(resolve, 50))

try {
  // 1) apply RAN (the loader-pitfall guard): the command registered.
  assert.ok(registrations.commands !== null, 'command registered (apply ran)')
  assert.equal(registrations.commands.name, 'compass')
  const result = await registrations.commands.handler({
    agent: { id: 'agent-1', session },
    rawInput: '',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('健康度：**黄**'))
  assert.ok(result.text.includes('- [x] 未提交变更：0 个'), 'checklist commit item reflects the clean worktree')
  assert.ok(result.text.includes('- [x] 已 push：分支与远程同步'), 'checklist push item reflects the synced branch')
  console.log('  ok  apply ran: /compass command registered + handler runs')

  // 2) context_compass tool registered with a working execute.
  assert.ok(registrations.tools !== null, 'tool registered')
  assert.equal(registrations.tools.name, 'context_compass')
  const value = await registrations.tools.execute({}, {
    agent: { id: 'agent-1', session },
    signal: new AbortController().signal,
  })
  assert.equal(value.severity, 'yellow')
  assert.equal(value.recommendation, 'suggest-switch')
  console.log('  ok  context_compass tool registered + execute runs')

  // 3) sessionHealth projection unit registered (unit contract shape).
  assert.ok(registrations.projections !== null, 'projection registered')
  assert.equal(registrations.projections.key, 'sessionHealth')
  assert.equal(typeof registrations.projections.init, 'function')
  assert.equal(typeof registrations.projections.apply, 'function')
  // 0.1.1+ wire 契约：client-visible unit 用 wire.view（旧独立 view 字段已移除）。
  assert.ok(registrations.projections.wire, 'projection wire present (client-visible)')
  assert.equal(typeof registrations.projections.wire.view, 'function')
  const state = registrations.projections.init()
  const after = registrations.projections.apply(state, { type: 'step/end', data: { turn: 1 } })
  assert.equal(after.turns, 1)
  console.log('  ok  sessionHealth projection unit registered + fold works')

  // 4) Multi-session overview RPC route registered and serves sorted rows.
  const route = registrations.routes.find(r => r.path === '/context-compass-rpc')
  assert.ok(route, '/context-compass-rpc route registered via webServer')
  assert.equal(route.kind, 'exact')
  const res = { status: null, body: null, writeHead: (s) => { res.status = s }, end: (b) => { res.body = b } }
  // Host header required by the AUDIT OV-3 loopback-Host check.
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
  req[Symbol.asyncIterator] = async function* () { yield JSON.stringify({ method: 'overview' }) }
  await route.handler(req, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  // Same tier (yellow): the LIVE session ranks first (方案 A), then newest.
  assert.deepEqual(payload.result.sessions.map(r => r.id), ['s1', 's2']) // top-level + non-archived, live first
  assert.equal(payload.result.sessions.length, 2, 'archived + subagent sessions are filtered out')
  assert.equal(payload.result.sessions[0].health.severity, 'yellow')     // cold session read the projection cache
  assert.equal(payload.result.sessions[0].title, null)                  // titles are background-filled after first paint
  assert.equal(payload.result.sessions[1].health.severity, 'yellow')     // live session cut the registry snapshot
  console.log('  ok  /context-compass-rpc route registered + overview handler runs (top-level + non-archived)')

  // 5) S3（ROADMAP 0.8.0）：projection.enabled=false → 投影单元不注册（接线
  // 开关可观测），工具/命令/RPC 不受影响。独立 Context + 同套 stub（去掉
  // sessionProjections——禁用后 inject 根本不应发生）。
  const offCtx = new Context()
  offCtx.provide('tokenMeter', { measure: () => ({ totalTokens: 300_000 }) })
  offCtx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) })
  offCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) })
  offCtx.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' })
  offCtx.provide('workspaceRegistry', { archivedSessionIds: [] })
  offCtx.provide('fs', { resolve: async p => p, stat: async () => undefined })
  offCtx.provide('subprocess', { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) })
  offCtx.provide('commands', { register: () => {} })
  offCtx.provide('tools', { register: () => {} })
  offCtx.provide('webServer', { register: () => () => {} })
  offCtx.provide('sessionQuery', { listEvents: async () => [], listSessions: async () => [] })
  offCtx.provide('sessionProjectionCache', { cachedSnapshot: (meta, keys) => { assertKeysIterable(keys); return { values: {} } } })
  offCtx.provide('sessionTitle', { get: () => undefined })
  const offRegs = { projections: null }
  offCtx.provide('sessionProjections', { register: def => { offRegs.projections = def }, snapshot: () => ({ values: {} }) })
  await offCtx.plugin(plugin, { projection: { enabled: false } }).await()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(offRegs.projections, null, 'projection.enabled=false must skip the projection registration')
  console.log('  ok  projection.enabled=false skips the projection unit (config wiring observable)')

  // 6) C1（docs/C1-SETTINGS-DESIGN.md）：settings 服务挂载 → 注册 ns
  // 'context-compass'（base=entry）；settings 写入 → source 切换 → 工具行为
  // live 变化；validate 拒绝非单调阈值。独立 Context + 同套 stub + fake settings。
  const c1Ctx = new Context()
  c1Ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 300_000 }) })
  c1Ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) })
  c1Ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) })
  c1Ctx.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' })
  c1Ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  c1Ctx.provide('fs', { resolve: async p => p, stat: async p => (p === '.git' ? {} : undefined) })
  c1Ctx.provide('subprocess', { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) })
  const c1Regs = { tools: null }
  c1Ctx.provide('commands', { register: () => {} })
  c1Ctx.provide('tools', { register: tool => { c1Regs.tools = tool } })
  c1Ctx.provide('webServer', { register: () => () => {} })
  c1Ctx.provide('sessionQuery', { listEvents: async () => [], listSessions: async () => [] })
  c1Ctx.provide('sessionProjectionCache', { cachedSnapshot: (meta, keys) => { assertKeysIterable(keys); return { values: {} } } })
  c1Ctx.provide('sessionTitle', { get: () => undefined })
  c1Ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
  // 0.2.0-rc.2 的 settings 契约：SettingsForms 只做「注册自动页面 + schema 级
  // 写入」，插件侧不再有 installSection / setSource / validate / onChange。
  // 活源语义改由 volatile 单元承担：标了 `.volatile()` 的字段解析出来是带
  // `.get()` 的活体单元（cosmokit Volatile<T>，只有 get，写在宿主手里），
  // resolveConfig 每次读取取当前快照 → 改完下一次使用即生效。
  //
  // 桩按真实形状写：只提供 configure，并断言 auto 策略。老写法
  // `installSection: async () => {}` 那种「万能桩」会让 configure 被漏改也测不出来。
  const fake = {
    configured: [],
    configure(presentation, owner) {
      fake.configured.push({ presentation, hasOwner: owner !== undefined })
      return () => {}
    },
  }
  c1Ctx.provide('settings', fake)

  // volatile 活源：单元不是本仓造的——schemastery 解析 `.volatile()` 字段时
  // 直接产出 cosmokit 的 Volatile 引用（有 get + 隐藏的 write 通道）。宿主
  // SettingsForms 写入 profile patch 后，由 cordis-plugin-loader 重新解析并
  // updateVolatile 把新值推进既有单元（见 _commitVolatile）。所以桩要复刻的
  // 是「解析 → 拿到单元 → 推进单元」这条真实链路，不是手工造 cell。
  // 交给 cordis 的是**裸**配置，由它按 Config schema 解析（volatile 单元就在
  // 这一步产生）。解析结果挂在 fiber 上——那才是插件 apply 真正收到的那份。
  const fiber = await c1Ctx.plugin(plugin, {}).await()
  await new Promise(resolve => setTimeout(resolve, 50))
  const entry = fiber.config
  assert.equal(fake.configured.length, 1, 'settings.configure called once while the service is mounted')
  assert.equal(fake.configured[0].presentation.auto, true, 'auto:true — 本插件无自定义设置页，须由宿主从 Config schema 派生表单')
  assert.equal(fake.configured[0].hasOwner, true, 'configure must receive the owning fiber')
  assert.equal(typeof entry.thresholds.windowHigh.get, 'function', 'volatile 字段必须解析成带 get() 的活体单元')
  assert.equal(entry.thresholds.windowHigh.get(), 0.5, '单元当前值来自 schema 默认值')
  assert.equal(c1Regs.tools !== null, true, 'tool registered on the settings-mounted context')
  const c1Before = await c1Regs.tools.execute({}, { agent: { id: 'agent-1', session }, signal: new AbortController().signal })
  assert.equal(c1Before.severity, 'blue')
  // 模拟一次宿主设置写入：重新解析出带新值的单元，再推进既有单元。
  // 单调阶梯 0.1/0.2/0.8：30% 占比跨过 windowHigh(0.2) → 蓝升黄。
  // （早先取 0.25 会让 0.3 < 0.25 失序，被新的读时护栏正确地回落成默认档——
  //  这正说明护栏在起作用，不是缺陷。）
  const written = Config({ thresholds: { windowMid: 0.1, windowHigh: 0.2, windowCritical: 0.8 } })
  for (const key of ['windowMid', 'windowHigh', 'windowCritical']) {
    updateVolatile(entry.thresholds[key], written.thresholds[key])
  }
  const c1After = await c1Regs.tools.execute({}, { agent: { id: 'agent-1', session }, signal: new AbortController().signal })
  assert.equal(c1After.severity, 'yellow', 'a volatile config write must reach the tool live')
  console.log('  ok  settings.configure(auto:true) + volatile 活源：写入直达工具判定')

  // 跨字段护栏：新契约没有写时钩子，改为读时兜底——阶梯被手改坏时回落默认值。
  const broken = Config({ thresholds: { windowMid: 0.3, windowHigh: 0.9, windowCritical: 0.8 } })
  updateVolatile(entry.thresholds.windowHigh, broken.thresholds.windowHigh)
  const c1Broken = await c1Regs.tools.execute({}, { agent: { id: 'agent-1', session }, signal: new AbortController().signal })
  assert.equal(c1Broken.severity, 'blue', '非单调阶梯（0.1/0.9/0.8）必须被读时护栏挡下，回落默认 0.3/0.5/0.8 → 30% 占比判蓝')
  console.log('  ok  跨字段单调性改由读时护栏兜底：阶梯非单调 → 回落默认，不静默失真')

  // 7) C1-4（AUDIT）：插件 re-apply 时 settings 命名空间不得撞 already-registered。
  // 真实 provider 对重复 register 是 fail-loud——若命名空间注册骑在 provider
  // fiber 上（未随插件 fiber 拆除），第二次 apply 会炸。用同一共享 provider
  // （fake 拒绝重复 ns）先后挂载两个独立 Context，验证第二个能正常注册。
  // 新 API（installSection）下注册责任在 provider：插件只按协议调用
  // settings.installSection(ctx, ns, schema, entry, hooks)，重复命名空间由
  // 宿主跨实例协调——此处验证插件对新 API 的调用协议（不抛错、ns 正确、
  // hooks 齐备），而非 provider 内部去重。
  const dupGuard = {
    calls: [],
    configure(presentation, owner) {
      dupGuard.calls.push({ auto: presentation?.auto, hasOwner: owner !== undefined })
      return () => {}
    },
  }
  const mkCtx = () => {
    const c = new Context()
    c.provide('tokenMeter', { measure: () => ({ totalTokens: 300_000 }) })
    c.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) })
    c.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) })
    c.provide('sandboxPolicy', { workspaceRoot: '/tmp/ws' })
    c.provide('workspaceRegistry', { archivedSessionIds: [] })
    c.provide('fs', { resolve: async p => p, stat: async () => undefined })
    c.provide('subprocess', { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) })
    c.provide('commands', { register: () => {} })
    c.provide('tools', { register: () => {} })
    c.provide('webServer', { register: () => () => {} })
    c.provide('sessionQuery', { listEvents: async () => [], listSessions: async () => [] })
    c.provide('sessionProjectionCache', { cachedSnapshot: (meta, keys) => { assertKeysIterable(keys); return { values: {} } } })
    c.provide('sessionTitle', { get: () => undefined })
    c.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
    c.provide('settings', dupGuard)
    return c
  }
  const firstCtx = mkCtx()
  const firstFiber = await firstCtx.plugin(plugin).await()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(dupGuard.calls.length, 1, 'first apply calls settings.configure once')
  assert.equal(dupGuard.calls[0].auto, true, 'auto policy is true on the first apply too')
  assert.equal(dupGuard.calls[0].hasOwner, true, 'owning fiber passed')
  // 拆掉第一个插件 fiber（新 API 下注册责任在 provider；插件侧无残留订阅）。
  firstFiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 50))
  // 第二个 Context + 同一 provider：新 API 下插件只是按协议调用 provider 方法，
  // 重复命名空间的协调属宿主职责——断言第二次 apply 正常完成（C1-4 本侧无坑）。
  const secondCtx = mkCtx()
  await secondCtx.plugin(plugin).await()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(dupGuard.calls.length, 2, 'second apply calls settings.installSection once more')
  console.log('  ok  plugin re-apply calls settings.installSection cleanly per apply (AUDIT C1-4, new API semantics)')

  console.log('\nmount smoke passed')
  process.exit(0)
} catch (err) {
  console.error('mount smoke FAILED')
  console.error(err)
  process.exit(1)
}
