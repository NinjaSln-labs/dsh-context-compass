/**
 * dsh-context-compass — client bundle mount test.
 *
 * Reproduces the browser boot path in Node: the built bundle registers via
 * `window.__ModuleLoader__.load({ id, factory })`, the factory returns the
 * module exports, and the loader mounts those exports through `ctx.plugin()`
 * with the exports' own `inject` list. Verifies:
 * - the bundle registers with the right id and exports apply/inject/name
 * - every injected service resolves in a realistic context (no cordis
 *   "cannot get property X without inject", no pending waits)
 * - apply() actually runs and registers the badge seat
 *
 * This catches both failure modes seen in the live boot: an inject entry
 * that can never resolve (remote.sessionHealth → pending forever) and a
 * missing inject entry (ctx.remote without 'remote' → hard throw).
 *
 *   npm run build && node scripts/client-mount.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { makeCommandsExecute, resetCommandCalls, commandCalls } from './tests/helpers.mjs'

const require = createRequire(import.meta.url)

// 1) Capture the __ModuleLoader__ registration the bundle performs on import.
let handoff = null
globalThis.window = {
  __ModuleLoader__: {
    load: h => {
      if (handoff !== null) throw new Error('duplicate registration')
      handoff = h
    },
  },
}
await import('../lib/client.js')
assert.ok(handoff !== null, 'bundle must register via window.__ModuleLoader__.load')
assert.equal(handoff.id, 'dsh-context-compass')

// 2) Materialize the module: the loader calls factory(require) and uses the
//    returned module.exports as the plugin module.
const plugin = handoff.factory(require)
assert.equal(typeof plugin.apply, 'function', 'exports must carry apply')
assert.equal(plugin.name, 'dsh-context-compass')
assert.ok(Array.isArray(plugin.inject), 'exports must carry the inject list')
assert.ok(plugin.inject.includes('remote'), 'ctx.remote reads need the remote root injected')
assert.ok(plugin.inject.includes('remote.commands'), 'remote.commands sub-service must be injected')
assert.ok(!plugin.inject.includes('remote.sessionHealth'), 'a plugin Remote can never mount client-side — must not be injected')
assert.ok(plugin.inject.includes('locale'), 'locale must be injected for the currency-by-region display')
assert.ok(plugin.inject.includes('uiWorkspace'), 'uiWorkspace must be injected — 0.2.0-rc.2 removed ctx.sessions.open, so this is the only session-navigation path')
console.log('  ok  bundle registered via __ModuleLoader__ with apply/inject/name')

// 2b) The /compass report parser is exported and correct.
const FULL_REPORT = [
  '**建议在任务边界收尾**（健康度：**黄**）',
  '上下文已占窗口 51%，早期内容开始被压缩；若剩余工作还多，开新会话更划算。',
  '',
  '详情：',
  '- 会话规模：17 轮 / 28 条消息 / 303 条回复',
  '- 每轮输入约 512K token（窗口 51%）；窗口 1M',
  '- 缓存命中率 100%（上次请求——命中高说明上下文稳定且便宜；压缩会重置命中）',
  '- 计费预期：约 ¥0.05/轮（≈$0.01；输入价 ¥1.5/M / $0.22 闲时价，缓存命中 ¥0.05/M / $0.007，不含输出）',
  '- 已压缩 2 次：早期细节概要化（上次压缩比例 ≈ 42%，按压缩前后压力快照差值推断——快照口径，非精确统计）',
  '',
  '切换前检查：',
  '- [x] 未提交变更：0 个',
  '- [ ] 已 push：## main...origin/main [ahead 2]',
].join('\n')
const parsed = plugin.parseCompassReport(FULL_REPORT)
assert.equal(parsed.severity, 'yellow')
assert.equal(parsed.summary, '建议在任务边界收尾（健康度：黄）')
assert.ok(parsed.reason.includes('上下文已占窗口 51%'))
assert.equal(parsed.metrics.length, 5)
assert.ok(parsed.metrics[4].startsWith('已压缩 2 次') && parsed.metrics[4].includes('上次压缩比例 ≈ 42%'))
assert.equal(parsed.checklist.length, 2)
const junk = plugin.parseCompassReport('随便一段文本\n没有结构')
assert.equal(junk.severity, null)
assert.equal(junk.summary, '随便一段文本')
console.log('  ok  parseCompassReport: severity/summary/metrics/checklist extraction')

// 2c) 尾部交接快照段（buildCommandText 始终追加）不得污染卡片 reason。
const WITH_SNAPSHOT = [
  '**放心继续**（健康度：**绿**）',
  '上下文只用了窗口的 2%，空间充足，没有切换的必要。',
  '',
  '详情：',
  '- 会话规模：2 轮 / 3 条消息 / 2 条回复',
  '',
  '---',
  '交接快照（context-compass-handoff-snapshot）',
  'severity: green',
  'recommendation: continue',
  'timestamp: 2026-08-19T10:00:00.000Z',
].join('\n')
const snapParsed = plugin.parseCompassReport(WITH_SNAPSHOT)
assert.equal(snapParsed.reason, '上下文只用了窗口的 2%，空间充足，没有切换的必要。', '快照段不得混入 reason')
assert.equal(snapParsed.metrics.length, 1)
// checklist 之后的快照段同样截断，checklist 收集不受影响。
const WITH_CHECKLIST_SNAP = [
  '**建议在任务边界收尾**（健康度：**黄**）',
  'r',
  '',
  '切换前检查：',
  '- [ ] 未提交变更：2 个',
  '- [ ] 已 push：## main...origin/main [ahead 2]',
  '',
  '---',
  '交接快照（context-compass-handoff-snapshot）',
  'severity: yellow',
  'timestamp: 2026-08-19T10:00:00.000Z',
].join('\n')
const snapCheck = plugin.parseCompassReport(WITH_CHECKLIST_SNAP)
assert.equal(snapCheck.checklist.length, 2)
assert.ok(!snapCheck.reason.includes('交接快照'), '快照段不得混入 reason（有 checklist 时）')
console.log('  ok  parseCompassReport: trailing handoff-snapshot block does not pollute reason')

// 2c) The compaction-aware merge helper is exported and correct.
const proj = {
  severity: 'yellow', advice: 'a', ratio: 0.6, total: 600_000, window: 1_000_000,
  turns: 1, userMessages: 1, assistantMessages: 1, compactions: 0,
}
const merged = plugin.mergePressure(proj, { pressureTokens: 650_000, projectedTokens: 300_000, contextWindow: 1_000_000 })
assert.equal(merged.total, 600_000, 'sessionHealth total wins when present')
assert.equal(merged.projected, 300_000, 'projectedTokens surfaces for the tooltip row')
assert.equal(merged.ratio, 0.6)
const fallback = plugin.mergePressure(undefined, { pressureTokens: 650_000, projectedTokens: 300_000, contextWindow: 2_000_000 })
assert.equal(fallback.total, 650_000)
assert.equal(fallback.window, 2_000_000)
assert.equal(fallback.ratio, 0.325)
const compacted = plugin.mergePressure(
  { severity: 'green', advice: 'a', ratio: null, total: null, window: 1_000_000, turns: 0, userMessages: 0, assistantMessages: 0, compactions: 0 },
  { projectedTokens: 300_000 },
)
assert.equal(compacted.total, 300_000, 'projectedTokens fills a missing host total')
console.log('  ok  mergePressure: compaction-aware occupancy merge')

// 2d) 压缩后判定滞后 (lagOf): severity rides last-wins pressure, the occupancy
//     bar rides compaction-aware projectedTokens — divergence after a
//     compaction is annotated until the next request refreshes the verdict.
const lagProj = {
  severity: 'yellow', advice: 'a', ratio: 0.6, total: 600_000, window: 1_000_000,
  turns: 1, userMessages: 1, assistantMessages: 1, compactions: 1,
}
assert.deepEqual(
  plugin.lagOf(lagProj, { pressureTokens: 600_000, projectedTokens: 300_000, contextWindow: 1_000_000 }),
  { lag: true, oldPct: 60, newPct: 30 },
  'post-compaction divergence ≥5pp with compactions>0 → lag annotated',
)
assert.deepEqual(
  plugin.lagOf({ ...lagProj, compactions: 0 }, { pressureTokens: 600_000, projectedTokens: 300_000, contextWindow: 1_000_000 }),
  { lag: false, oldPct: 60, newPct: 30 },
  'divergence without a recorded compaction → no annotation',
)
assert.deepEqual(
  plugin.lagOf(lagProj, { pressureTokens: 600_000, projectedTokens: 590_000, contextWindow: 1_000_000 }),
  { lag: false, oldPct: 60, newPct: 59 },
  'sub-5pp divergence → no annotation (noise guard)',
)
assert.deepEqual(plugin.lagOf(lagProj, undefined), { lag: false, oldPct: 60, newPct: null })
console.log('  ok  lagOf: 压缩后判定滞后标注 (divergence gate + noise floor)')

// 3) Mount through a real cordis Context with the injected services provided
//    the way the web shell provides them. A minimal document stub records the
//    stylesheet tag the apply path must create (the client-modules contract:
//    a <style data-plugin> tag on document.head — there is no 'styles' service).
const styleTags = []
const documentStub = {
  querySelector: () => null,
  createElement: tag => ({ tag, dataset: {}, textContent: '' }),
  head: {
    appendChild: el => { styleTags.push(el) },
  },
}
globalThis.document = documentStub

const seats = []
const ctx = new Context()
ctx.provide('slots', {
  inject: (name, fn) => { seats.push({ name, fn }) },
  register: (...args) => args,
})
ctx.provide('sessions', {
  binding: () => ({ session: { projections: { faceOf: () => undefined } } }),
})
// execute 桩按宿主真实契约（元数 + 附件数组）守卫，见 helpers.mjs 的说明。
const commandsExecute = makeCommandsExecute()
ctx.provide('remote', { commands: { execute: commandsExecute } })
ctx.provide('remote.commands', { execute: commandsExecute })
ctx.provide('locale', { snapshot: { active: 'zh' } })
// 0.2.0-rc.2 的会话导航 owner（ctx.sessions.open 已删）——见 overview.tsx openSession。
const openSessionCalls = []
ctx.provide('uiWorkspace', {
  openSession: (target) => { openSessionCalls.push(target) },
})
// 0.2.0-rc.2 的配置页底座：`configForms.get(entryId)` 取代旧的
// `settingsScope.bind({namespace})`。快照字段（status/value/base/user/revision/
// writable/mode）逐项同构；mutate 回 Promise<boolean>（宿主是否受理）而非 void。
// 桩按真实形状写——旧的 bind 桩会让「还绑在 settingsScope 上」这类漏改全盲。
const configFormGets = []
const whileServedCalls = []
let configFormSnapshotReads = 0
const makeConfigForm = () => ({
  getSnapshot: () => {
    configFormSnapshotReads++
    return { status: 'ready', value: {}, base: {}, user: undefined, revision: 1, writable: true, mode: 'host' }
  },
  subscribe: () => () => {},
  mutate: async () => true,
  set: async () => true,
  unset: async () => true,
  dispose: async () => {},
})
ctx.provide('configForms', {
  get: (entryId) => { configFormGets.push(entryId); return makeConfigForm() },
  whileServed: (namespaces, register) => {
    whileServedCalls.push(namespaces)
    const dispose = register(new Set(namespaces))
    return () => { dispose() }
  },
})

try {
  await ctx.plugin(plugin).await()
} catch (error) {
  console.error('client mount FAILED — apply threw (missing inject?):')
  throw error
}

// 4) apply ran: the badge + two overview seats + the /compass card seat.
assert.equal(seats.length, 5, 'apply must register exactly five slot seats')
const byName = Object.fromEntries(seats.map(s => [s.name, s]))
assert.ok(byName['conversation.session.header.utilities'], 'badge seat registered')
assert.ok(byName['sidebar.footer.action'], 'overview opener seat registered')
assert.ok(byName['shell.overlay'], 'overview panel seat registered')
assert.ok(byName['conversation.chat.commandview'], 'commandview seat registered')
assert.ok(byName['plugins.item'], 'C2 config card seat registered (0.2.0 slot)')
assert.deepEqual(configFormGets, ['context-compass'], 'must take the form for our own settings namespace')
assert.deepEqual(whileServedCalls, [['context-compass']], 'page registration is gated on whileServed(our namespace)')
assert.ok(configFormSnapshotReads >= 1, 'get() → immediate project() must consume the form snapshot')
// Each seat factory must produce a working slots.register call.
const badgeReg = byName['conversation.session.header.utilities'].fn()
assert.equal(badgeReg[0].id, 'session-health-dot')
const footerReg = byName['sidebar.footer.action'].fn()
assert.equal(footerReg[0].id, 'session-health-overview')
assert.equal(footerReg[0].name, 'sidebar.footer.action')
const overlayReg = byName['shell.overlay'].fn()
assert.equal(overlayReg[0].id, 'session-health-overview-panel')
assert.equal(overlayReg[0].name, 'shell.overlay')
const cardReg = byName['conversation.chat.commandview'].fn()
assert.equal(cardReg[0].name, 'conversation.chat.commandview')
assert.equal(cardReg[0].key, 'compass')
const settingsReg = byName['plugins.item'].fn()
assert.equal(settingsReg[0].name, 'plugins.item')
assert.equal(settingsReg[0].id, 'context-compass', 'id is the settings namespace — 与宿主 whileServed 的键一致')
assert.equal(settingsReg[0].order, 90)
console.log('  ok  apply ran: badge + overview opener + overview panel + /compass card seats + settings card')

// 4b) commands.execute 桩的契约保真度（0.2.0-rc.2 破口回归）。
//     徽章点击与面板点行走同一条 execute 路径，两处调用点都有 try/catch 静默。
//     本套件不渲染组件（无 DOM），故此处断言的是「桩按宿主真实元数守卫」——
//     桩一旦回退成 `async () => ({ok:true})`，两参调用就会重新全盲。真正的
//     运行时证据在 visual badge spec（点行/点徽章）与活宿主取证里。
{
  resetCommandCalls()
  await commandsExecute('sess-1', '/compass', [])
  assert.deepEqual(commandCalls.at(-1)?.slice(0, 2), ['sess-1', '/compass'], 'execute 前两参：agentId + line')
  assert.deepEqual(commandCalls.at(-1)?.[2], [], '第三参 submittedAttachments 必须是数组（纯文本调用传空数组）')
  let threw = null
  try { await commandsExecute('sess-1', '/compass') } catch (e) { threw = e.message }
  assert.match(threw ?? '', /expected 3 business argument\(s\)/, '两参调用必须被桩拒绝——否则等于退回旧的全盲桩')
  console.log('  ok  commands.execute 桩: 三参契约保真（两参被拒，对齐宿主 facade 元数守卫）')
}
// 4c) 会话导航契约（0.2.0-rc.2 破口回归）：ctx.sessions.open 已删除，面板点行
//     改走 ctx.uiWorkspace.openSession。旧路径抛 TypeError 且被 try/catch 吞掉，
//     点行后连一次会话 API 都不发——纯静默失效。
{
  openSessionCalls.length = 0
  const nav = ctx.get('uiWorkspace')
  assert.ok(nav !== undefined && typeof nav.openSession === 'function', 'uiWorkspace 服务必须提供 openSession')
  nav.openSession('sess-42')
  assert.deepEqual(openSessionCalls, ['sess-42'], 'openSession 必须把目标 id 交给视图 owner')
  assert.equal(typeof ctx.get('sessions').open, 'undefined', 'ctx.sessions.open 在 0.2.0-rc.2 已不存在（桩不得再提供它，否则会掩盖漏改）')
  console.log('  ok  会话导航: uiWorkspace.openSession 在位，ctx.sessions.open 确认已移除')
}

// 5) The stylesheet was injected the client-modules way.
assert.equal(styleTags.length, 1, 'apply must create exactly one style tag')
assert.equal(styleTags[0].dataset.plugin, 'dsh-context-compass', 'style tag must carry data-plugin (HMR ownership)')
assert.ok(styleTags[0].textContent.includes('.sh-badge'), 'style tag must carry the badge CSS')
console.log('  ok  stylesheet injected as <style data-plugin="dsh-context-compass">')

// 5b) 缺 configForms 服务（探测路径失效）→ 整个 client bundle 必须照常挂载。
// 这是本仓最险的一条：settingsScope 原在 required `inject` 里，cordis 遇到永不
// 出现的 required 服务会让 entry 永远 pending —— apply 根本不跑，徽章/面板/命令卡
// 一起消失且零报错。回归钉住「缺 settingsScope 只掉配置卡，不掉其它四席」。
{
  const bare = new Context()
  const bareSeats = []
  bare.provide('slots', {
    inject: (name, fn) => { bareSeats.push({ name, fn }) },
    register: (...args) => args,
  })
  bare.provide('sessions', { binding: () => undefined, open: () => {}, list: { getSnapshot: () => ({ byId: {} }) } })
  const bareExecute = makeCommandsExecute()
  bare.provide('remote', { commands: { execute: bareExecute } })
  bare.provide('remote.commands', { execute: bareExecute })
  bare.provide('locale', { snapshot: { active: 'zh' } })
  bare.provide('uiWorkspace', { openSession: () => {} })
  // 刻意不 provide configForms —— 复刻配置页底座不可用的实况。
  let applied = false
  try {
    await bare.plugin(plugin).await()
    applied = true
  } catch (error) {
    console.error('client mount FAILED without configForms — apply threw:')
    throw error
  }
  assert.ok(applied, '缺 configForms 时 apply 仍须完成（不得因探测抛错）')
  const bareByName = Object.fromEntries(bareSeats.map(s => [s.name, s]))
  for (const seat of [
    'conversation.session.header.utilities',
    'sidebar.footer.action',
    'shell.overlay',
    'conversation.chat.commandview',
  ]) {
    assert.ok(bareByName[seat], `缺 configForms 时 ${seat} 仍须注册`)
  }
  assert.equal(bareByName['plugins.item'], undefined, '缺 configForms 时只跳过 C2 配置卡')
  console.log('  ok  no configForms: four seats survive, C2 card skipped')
}

// 6) C2 card-form controller unit tests (fake scope drives the form).
const { CompassCardForm } = await import('../lib/client/settings-card/card-form.js')
const { FIELDS: CF_FIELDS } = await import('../lib/client/settings-card/fields.js')

function makeScope(initial) {
  const state = {
    status: 'ready',
    value: structuredClone(initial),
    base: structuredClone(initial),
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set()
  const calls = []
  const api = {
    state, calls,
    getSnapshot: () => state,
    subscribe: l => { listeners.add(l); return () => listeners.delete(l) },
    mutate: async (ops, rev) => {
      calls.push({ ops, rev })
      const user = state.user === undefined ? {} : structuredClone(state.user)
      for (const op of ops) {
        if (op.op === 'set') {
          let cur = user
          for (let i = 0; i < op.path.length - 1; i++) {
            if (typeof cur[op.path[i]] !== 'object' || cur[op.path[i]] === null) cur[op.path[i]] = {}
            cur = cur[op.path[i]]
          }
          cur[op.path[op.path.length - 1]] = op.value
        } else {
          const seg = op.path
          let cur = user
          for (let i = 0; i < seg.length - 1; i++) {
            if (typeof cur?.[seg[i]] !== 'object' || cur?.[seg[i]] === null) break
            cur = cur[seg[i]]
          }
          if (cur && typeof cur === 'object') delete cur[seg[seg.length - 1]]
        }
      }
      state.user = Object.keys(user).length === 0 ? undefined : user
      state.revision = rev + 1
      // Mirror value = base merged with user
      state.value = structuredClone(state.base)
      function mergeUser(target, source) {
        for (const [k, v] of Object.entries(source)) {
          if (v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
            if (typeof target[k] !== 'object' || target[k] === null) target[k] = {}
            mergeUser(target[k], v)
          } else {
            target[k] = v
          }
        }
      }
      if (state.user) mergeUser(state.value, state.user)
      for (const l of [...listeners]) l()
      // 0.2.0-rc.2 契约：mutate 回 Promise<boolean>（宿主是否受理），不是 void。
      return true
    },
  }
  return api
}

const CF_DEFAULT = {
  thresholds: { windowMid: 0.3, windowHigh: 0.5, windowCritical: 0.8,
    economyTokenFloor: 50000, economyWindowRatio: 0.3, economyRoundFloor: 10,
    messageCountProxy: 800, messageCountWindowRatio: 0.002 },
  checks: { git: { enabled: true }, handoff: { enabled: true, paths: [] },
    sessionResume: { enabled: true }, processes: { enabled: false }, knowledge: { enabled: true } },
  projection: { enabled: true },
  cost: { cacheHitDiscount: 0.1, inputPricePerM: 0.28, priceSource: 'auto',
    priceUrl: 'u1', priceFallbackUrl: 'u2', priceRefreshHours: 24 },
}

// 6a) shell states
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const s = form.shell()
  assert.equal(s.available, true, 'shell: available when ready')
  assert.equal(s.writable, true, 'shell: writable')
  assert.equal(s.dirty, false, 'shell: not dirty initially')
  assert.equal(s.invalid, false, 'shell: not invalid initially')
  assert.equal(s.saving, false, 'shell: not saving initially')
  assert.equal(s.failed, false, 'shell: not failed initially')
  // read-only
  scope.state.writable = false
  form['publish']()
  const s2 = form.shell()
  assert.equal(s2.writable, false, 'shell: writable reflects scope')
  // unavailable
  scope.state.status = 'unavailable'
  form['publish']()
  const s3 = form.shell()
  assert.equal(s3.available, false, 'shell: available=false when unavailable')
  console.log('  ok  card-form: shell states')
}

// 6b) editText: text draft + dirty tracking
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', '0.42')
  const f = form.field('thresholds.windowMid')
  assert.equal(f.text, '0.42', 'editText: text draft stored')
  assert.equal(f.overridden, true, 'editText: overridden=true')
  assert.equal(f.invalid, false, 'editText: valid number')
  const s = form.shell()
  assert.equal(s.dirty, true, 'editText: dirty after edit')
  console.log('  ok  card-form: editText draft')
}

// 6c) toggle: boolean checked channel
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.toggle('checks.processes.enabled', true)
  const f = form.field('checks.processes.enabled')
  assert.equal(f.checked, true, 'toggle: checked=true')
  assert.equal(f.text, '', 'toggle: text is empty for boolean')
  assert.equal(f.overridden, true, 'toggle: overridden=true')
  console.log('  ok  card-form: toggle boolean')
}

function mergeUserInto(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof target[k] !== 'object' || target[k] === null) target[k] = {}
      mergeUserInto(target[k], v)
    } else { target[k] = v }
  }
}

// 6d) overridden: user-layer presence
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  // Simulate an external write that creates a user override
  scope.state.user = { thresholds: { windowMid: 0.99 } }
  scope.state.value = structuredClone(CF_DEFAULT)
  mergeUserInto(scope.state.value, scope.state.user)
  form['publish']()
  const f = form.field('thresholds.windowMid')
  assert.equal(f.overridden, true, 'overridden: user-layer presence detected')
  assert.equal(f.text, '0.99', 'overridden: shows user value')
  console.log('  ok  card-form: overridden presence')
}

// 6e) reset → unset
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  // First, create a user override
  scope.state.user = { thresholds: { windowMid: 0.99 } }
  mergeUserInto(scope.state.value, scope.state.user)
  form['publish']()
  // Then reset
  actions.resetField('thresholds.windowMid')
  const f = form.field('thresholds.windowMid')
  assert.equal(f.overridden, false, 'reset: overridden=false after clear')
  // shell() triggers pendingOps which should produce an unset op
  form.shell()
  assert.equal(scope.calls.length, 0, 'reset: no mutate yet (pendingOps consumed)')
  console.log('  ok  card-form: reset clears override')
}

// 6f) atomic mutate: multiple dirty fields → one mutate call
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', '0.42')
  actions.editText('thresholds.windowHigh', '0.6')
  await actions.save()
  assert.equal(scope.calls.length, 1, 'atomic: single mutate call')
  const ops = scope.calls[0].ops
  assert.equal(ops.length, 2, 'atomic: 2 ops in one mutate')
  const paths = ops.map(o => o.path.join('.'))
  assert.ok(paths.includes('thresholds.windowMid'), 'atomic: windowMid op present')
  assert.ok(paths.includes('thresholds.windowHigh'), 'atomic: windowHigh op present')
  assert.equal(form.shell().dirty, false, 'atomic: dirty=false after save')
  console.log('  ok  card-form: atomic mutate')
}

// 6g) save failure: failed=true, drafts retained
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', '0.42')
  // Make mutate throw
  scope.mutate = async () => { throw new Error('network') }
  await actions.save()
  assert.equal(form.shell().failed, true, 'failed: failed=true on error')
  const f = form.field('thresholds.windowMid')
  assert.equal(f.text, '0.42', 'failed: draft retained after error')
  console.log('  ok  card-form: save failure retains drafts')
}

// 6h) invalid field blocks save
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', 'abc')
  const f = form.field('thresholds.windowMid')
  assert.equal(f.invalid, true, 'invalid: parse error detected')
  assert.equal(f.error, '请输入有效值', 'invalid: error message present')
  assert.equal(form.shell().invalid, true, 'invalid: shell reports invalid')
  // save should not fire (ops.length===0 due to invalid)
  await actions.save()
  assert.equal(scope.calls.length, 0, 'invalid: no mutate when invalid')
  console.log('  ok  card-form: invalid blocks save')
}

// 6i) semantic comparison: editing back to same value is not dirty
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  // Edit to same value as current (0.3)
  actions.editText('thresholds.windowMid', '0.3')
  form.shell() // trigger pendingOps to compute dirty
  const s = form.shell()
  assert.equal(s.dirty, false, 'semantic: same value not dirty')
  console.log('  ok  card-form: semantic comparison (no false dirty)')
}

// 6j) semantic comparison: strings 'a,b' vs 'a, b' not dirty
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  // Set a user override first
  scope.state.user = { checks: { handoff: { paths: ['a', 'b'] } } }
  mergeUserInto(scope.state.value, scope.state.user)
  form['publish']()
  // Edit with different spacing
  actions.editText('checks.handoff.paths', 'a, b')
  form.shell() // trigger pendingOps
  const s = form.shell()
  assert.equal(s.dirty, false, 'semantic: strings normalized, not dirty')
  console.log('  ok  card-form: semantic comparison (strings)')
}

// 6k) deferred-mutate: object identity guard
{
  const resolveRef = { resolved: false }
  const scope = makeScope(CF_DEFAULT)
  const originalMutate = scope.mutate
  scope.mutate = async (ops, rev) => {
    // Return a promise that resolves later
    return new Promise(resolve => {
      setTimeout(() => {
        resolveRef.resolved = true
        originalMutate.call(scope, ops, rev).then(resolve)
      }, 50)
    })
  }
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', '0.42')
  const savePromise = actions.save()
  // While saving, edit again
  actions.editText('thresholds.windowMid', '0.99')
  await savePromise
  // After resolve, the LATER edit (0.99) should be preserved
  const f = form.field('thresholds.windowMid')
  assert.equal(f.text, '0.99', 'deferred-mutate: later edit preserved')
  console.log('  ok  card-form: deferred-mutate object identity guard')
}

// 6l) clear without override → revoke (no unset, staged cleared)
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  // Reset a field that has NO user override
  actions.resetField('thresholds.windowMid')
  form.shell() // trigger pendingOps → should revoke the clear
  const f = form.field('thresholds.windowMid')
  assert.equal(f.overridden, false, 'clear-no-override: not overridden')
  assert.equal(form.shell().dirty, false, 'clear-no-override: not dirty')
  console.log('  ok  card-form: clear without override revokes')
}

// 6m) discard
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  actions.editText('thresholds.windowMid', '0.42')
  actions.toggle('checks.processes.enabled', true)
  assert.equal(form.shell().dirty, true, 'discard setup: dirty before discard')
  actions.discard()
  assert.equal(form.shell().dirty, false, 'discard: not dirty after discard')
  const f1 = form.field('thresholds.windowMid')
  assert.equal(f1.text, '0.3', 'discard: text reverted to original')
  const f2 = form.field('checks.processes.enabled')
  assert.equal(f2.checked, false, 'discard: checkbox reverted')
  console.log('  ok  card-form: discard clears all drafts')
}

// 6n) threshold monotonic validation: editing mid above current high is invalid
{
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, CF_FIELDS)
  const actions = form.actions()
  // Edit mid to 0.6 — exceeds current high=0.5 → invalid
  actions.editText('thresholds.windowMid', '0.6')
  const f = form.field('thresholds.windowMid')
  assert.equal(f.invalid, true, 'threshold: mid > high detected')
  assert.ok(f.error?.includes('阶梯'), 'threshold: error mentions ladder')
  // Editing high below current mid (staged) should also be invalid
  // Note: thresholdError reads effectiveValue (scope value), not staged text,
  // so editing high=0.4 while mid is staged at 0.6 passes client-side check
  // (host validateThresholdLadder catches it on save).
  console.log('  ok  card-form: threshold monotonic validation')
}

// 6o) parseField range: min0max1 number
{
  const rangeField = CF_FIELDS.find(f => f.path.join('.') === 'thresholds.windowMid')
  assert.ok(rangeField, 'parseField: range field exists')
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, rangeField ? [rangeField] : CF_FIELDS.slice(0, 1))
  const actions = form.actions()
  actions.editText(rangeField.path.join('.'), '1.5')
  const f = form.field(rangeField.path.join('.'))
  assert.equal(f.invalid, true, 'parseField: >1 rejected for min0max1')
  assert.ok(f.error?.includes('0-1'), 'parseField: error mentions 0-1 range')
  console.log('  ok  card-form: parseField range validation')
}

// 6p) select option validation
{
  const selectField = CF_FIELDS.find(f => f.path.join('.') === 'cost.priceSource')
  assert.ok(selectField, 'parseField: select field exists')
  const scope = makeScope(CF_DEFAULT)
  const form = new CompassCardForm(scope, selectField ? [selectField] : CF_FIELDS.slice(0, 1))
  const actions = form.actions()
  actions.editText(selectField.path.join('.'), 'unknown')
  const f = form.field(selectField.path.join('.'))
  assert.equal(f.invalid, true, 'parseField: invalid select option rejected')
  console.log('  ok  card-form: parseField select validation')
}

// 6q) controlFor —— 渲染的唯一来源（0.12.1：FieldControl 直接消费本函数，断言即渲染契约）
{
  const { controlFor, saveBlocked, discardBlocked } = await import('../lib/client/settings-card/card.js')
  const spec = key => CF_FIELDS.find(f => f.path.join('.') === key)
  const field = { text: '', checked: false, invalid: false }

  const numberSpec = spec('thresholds.windowMid')
  assert.ok(numberSpec, 'controlFor: number field exists')
  assert.deepEqual(
    controlFor(numberSpec, { ...field, text: '0.5' }),
    { type: 'text', inputMode: 'decimal', text: '0.5' },
    'controlFor: number → text + inputMode decimal（小数点可输入）',
  )

  const boolSpec = spec('checks.handoff.enabled')
  assert.ok(boolSpec, 'controlFor: boolean field exists')
  assert.deepEqual(
    controlFor(boolSpec, { ...field, checked: true }),
    { type: 'checkbox', checked: true },
    'controlFor: boolean → checkbox with checked',
  )

  const selectSpec = spec('cost.priceSource')
  assert.ok(selectSpec, 'controlFor: select field exists')
  const selectControl = controlFor(selectSpec, field)
  assert.equal(selectControl.type, 'select', 'controlFor: select → select')
  assert.equal(selectControl.options, selectSpec.options, 'controlFor: select 透传 spec 选项（同源）')

  const stringSpec = spec('checks.git.workspaceRoot')
  assert.ok(stringSpec, 'controlFor: string field exists')
  assert.deepEqual(
    controlFor(stringSpec, { ...field, text: 'x' }),
    { type: 'text', inputMode: undefined, text: 'x' },
    'controlFor: string → text 不带 inputMode',
  )

  assert.equal(saveBlocked({ dirty: true, invalid: false, saving: false }), false, 'saveBlocked: 干净可存')
  assert.equal(saveBlocked({ dirty: true, invalid: true, saving: false }), true, 'saveBlocked: 非法禁存')
  assert.equal(saveBlocked({ dirty: false, invalid: false, saving: false }), true, 'saveBlocked: 无改动禁存')
  assert.equal(saveBlocked({ dirty: true, invalid: false, saving: true }), true, 'saveBlocked: 保存中禁存')

  // 回归：0.12.1 前 discard 复用 saveBlocked，非法草稿时用户被锁死无法放弃
  assert.equal(discardBlocked({ saving: false }), false, 'discardBlocked: 非法草稿仍可放弃（逃生通道）')
  assert.equal(discardBlocked({ saving: true }), true, 'discardBlocked: 保存中禁放弃')
  console.log('  ok  card: controlFor / saveBlocked / discardBlocked（渲染单一来源 + 放弃通道）')

// 6z) 落地判定以**回读**为准，不以 mutate 的返回值为准。
//     宿主的 boolean 只说「这次写入被受理」，真正的判据是写后回读里该 path
//     确实出现在 user 层——传输成功但字段没落下（被 schema 裁掉、命名空间换了）
//     时，返回值仍可能是 true。反过来回读能兜住所有假成功。
{
  const s2 = makeScope(structuredClone(CF_DEFAULT))
  s2.state.user = undefined
  s2.mutate = async () => false // 假装宿主拒收，但把值写进了 user 层
  const orig = s2.getSnapshot
  let calls = 0
  s2.getSnapshot = () => {
    calls++
    const snap = orig()
    return calls === 1 ? snap : { ...snap, user: { thresholds: { windowHigh: 0.4 } } }
  }
  const form2 = new CompassCardForm(s2, [CF_FIELDS[1]])
  const act2 = form2.actions()
  await act2.editText('thresholds.windowHigh', '0.4')
  await form2.save()
  assert.equal(form2.shell().failed, false, 'mutate 回 false 但回读见值 → 判为已落地（回读是权威）')
  form2.dispose()
  console.log('  ok  mutate 返回值不参与落地判定：写后回读说了算')
}
}

console.log('\nclient mount smoke passed')
process.exit(0)
