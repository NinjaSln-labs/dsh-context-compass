/**
 * Smoke domain: S3 — 配置生效冒烟（ROADMAP 0.8.0）。
 * 每个可调字段：改配置 → 可观测行为变化。锁「配置静默失效」。
 * Checks moved verbatim from the monolith (L1665-1780).
 */
import assert from 'node:assert/strict'
import { resolveConfig } from '../../lib/config.js'
import { healthView } from '../../lib/projection.js'
import { assess } from '../../lib/assess.js'
import { startPricingRefresh } from '../../lib/pricing.js'
import { check, config, signal, session, ctx, services, probesOn } from './helpers.mjs'

export async function run() {
  // （checks.processes.enabled 的 ON/OFF 双向已由前方 processes 专测覆盖。）

  await check('S3: thresholds.windowMid/High/Critical 各自移动 severity 边界', () => {
    const s40 = { turns: 1, userMessages: 0, assistantMessages: 0, compactions: 0, pressureTokens: 400_000, contextWindow: 1_000_000 }
    const s60 = { ...s40, pressureTokens: 600_000 }
    const s85 = { ...s40, pressureTokens: 850_000 }
    assert.equal(healthView(s40, config).severity, 'blue')
    assert.equal(healthView(s40, resolveConfig({ thresholds: { windowMid: 0.5 } })).severity, 'green')
    assert.equal(healthView(s60, config).severity, 'yellow')
    assert.equal(healthView(s60, resolveConfig({ thresholds: { windowHigh: 0.7 } })).severity, 'blue')
    assert.equal(healthView(s85, config).severity, 'red')
    assert.equal(healthView(s85, resolveConfig({ thresholds: { windowCritical: 0.95 } })).severity, 'yellow')
  })

  await check('S3: thresholds.economyTokenFloor / economyWindowRatio 移动经济档门槛', () => {
    // 无窗口 → 经济门槛 = economyTokenFloor（绝对值路径）。
    const noWindow = { turns: 1, userMessages: 0, assistantMessages: 0, compactions: 0, lastUsage: { inputTokens: 60_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    assert.equal(healthView(noWindow, config).severity, 'yellow') // 60K ≥ 默认 50K
    assert.equal(healthView(noWindow, resolveConfig({ thresholds: { economyTokenFloor: 100_000 } })).severity, 'green')
    // 1M 窗口 → 门槛 = max(floor, ratio × window)（窗口缩放路径）。
    const w1m = { turns: 1, userMessages: 0, assistantMessages: 0, compactions: 0, pressureTokens: 50_000, contextWindow: 1_000_000, lastUsage: { inputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    assert.equal(healthView(w1m, config).severity, 'green') // 200K < max(50K, 300K)
    assert.equal(healthView(w1m, resolveConfig({ thresholds: { economyWindowRatio: 0.1 } })).severity, 'yellow') // 200K ≥ 100K
  })

  await check('S3: thresholds.messageCountProxy / messageCountWindowRatio 移动代理阈值', () => {
    const noWindow = { turns: 1, userMessages: 600, assistantMessages: 400, compactions: 0 } // 1000 条
    assert.equal(healthView(noWindow, config).severity, 'blue') // 1000 ≥ 800
    assert.equal(healthView(noWindow, resolveConfig({ thresholds: { messageCountProxy: 5000 } })).severity, 'green')
    const w1m = { ...noWindow, pressureTokens: 10_000, contextWindow: 1_000_000 } // eff = max(800, 2000)
    assert.equal(healthView(w1m, config).severity, 'green') // 1000 < 2000
    assert.equal(healthView(w1m, resolveConfig({ thresholds: { messageCountWindowRatio: 0.001 } })).severity, 'blue') // eff 1000 → 命中
  })

  await check('S3: thresholds.economyRoundFloor 移动 A3 升级门槛', async () => {
    // 基线 ctx：经济命中（300K/1M 窗口）→ yellow；remainingRounds 5。
    const below = await assess(ctx, session, 'agent-1', signal, probesOn(config), { remainingRounds: 5 })
    assert.equal(below.severity, 'yellow') // 5 < 默认 floor 10：不升级
    const escalated = await assess(ctx, session, 'agent-1', signal, resolveConfig({ thresholds: { economyRoundFloor: 3 } }), { remainingRounds: 5 })
    assert.equal(escalated.severity, 'red') // 5 ≥ 3：黄升一档
    assert.ok(escalated.probes.some(p => p.includes('经济升级')), JSON.stringify(escalated.probes))
  })

  await check('S3: checks.git/handoff.enabled 关闭 → probe 标注；开启 → 真探测', async () => {
    const off = await assess(ctx, session, 'agent-1', signal, resolveConfig({ checks: { git: { enabled: false }, handoff: { enabled: false } } }), {})
    assert.ok(off.probes.some(p => p.includes('git 检查：已跳过（配置关闭）')), JSON.stringify(off.probes))
    assert.ok(off.probes.some(p => p.includes('交接文档检查：已跳过（配置关闭）')))
    const on = await assess(ctx, session, 'agent-1', signal, probesOn(config), {})
    assert.ok(!on.probes.some(p => p.includes('（配置关闭）')))
    assert.equal(on.handoff.isGitRepo, true)
  })

  await check('S3: checks.handoff.paths 空 → 未配置 probe；配置路径 → 按路径探测', async () => {
    const empty = await assess(ctx, session, 'agent-1', signal, probesOn(config), {})
    assert.ok(empty.probes.some(p => p.includes('交接文档：未配置检查路径')), JSON.stringify(empty.probes))
    // fs stub：stat('HANDOFF.md') 存在 → 配置路径被真实探测。
    const named = await assess(ctx, session, 'agent-1', signal, resolveConfig({ checks: { handoff: { paths: ['HANDOFF.md'] } } }), {})
    assert.ok(!named.probes.some(p => p.includes('交接文档：未配置检查路径')))
    assert.equal(named.handoff.hasHandoff, true)
  })

  await check('S3: checks.sessionResume.enabled 控制 probe 行', async () => {
    const on = await assess(ctx, session, 'agent-1', signal, probesOn(config), {})
    assert.ok(on.probes.some(p => p.includes('DSH 会话持久化')), JSON.stringify(on.probes))
    const off = await assess(ctx, session, 'agent-1', signal, resolveConfig({ checks: { sessionResume: { enabled: false } } }), {})
    assert.ok(!off.probes.some(p => p.includes('DSH 会话持久化')))
  })

  await check('S3: checks.knowledge.enabled 关闭 → 装了服务也不探测', async () => {
    const kCtx = { get: name => (name === 'knowledge' ? { search: async () => ({ hits: [] }) } : services[name]) }
    const off = await assess(kCtx, session, 'agent-1', signal, resolveConfig({ checks: { knowledge: { enabled: false } } }), {})
    assert.ok(!off.probes.some(p => p.includes('跨会话回顾')), JSON.stringify(off.probes))
    const on = await assess(kCtx, session, 'agent-1', signal, probesOn(config), {})
    assert.ok(on.probes.some(p => p.includes('跨会话回顾')), JSON.stringify(on.probes))
  })

  await check('S3: cost.cacheHitDiscount / inputPricePerM 改动直接反映在计费数字', () => {
    const s = { turns: 1, userMessages: 0, assistantMessages: 0, compactions: 0, lastUsage: { inputTokens: 50_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 } }
    const d1 = healthView(s, config) // discount 0.1 → 计费当量 100K
    const d2 = healthView(s, resolveConfig({ cost: { cacheHitDiscount: 0.5 } })) // → 300K
    assert.equal(d1.effectivePerRound, 100_000)
    assert.equal(d2.effectivePerRound, 300_000)
    assert.ok(Math.abs(d1.effectivePerRoundUsd - (100_000 * 0.28) / 1e6) < 1e-9)
    const p2 = healthView(s, resolveConfig({ cost: { inputPricePerM: 1.0 } })) // 静态单价 → $0.10/轮
    assert.ok(Math.abs(p2.effectivePerRoundUsd - (100_000 * 1.0) / 1e6) < 1e-9)
  })

  await check('S3: cost.priceSource=static 不刷新；auto 按 priceUrl/priceFallbackUrl 刷新且 cadence 生效', () => {
    const refreshAnyCalls = []
    const cache = { refreshAny: urls => { refreshAnyCalls.push(urls); return Promise.resolve(false) } }
    const noopCtx = { effect: fn => (typeof fn === 'function' ? fn() : fn), get: () => undefined, logger: undefined }
    // static：连 refreshAny 都不碰（价格完全走配置静态值）。
    startPricingRefresh(noopCtx, { ...config.cost, priceSource: 'static' }, cache)
    assert.equal(refreshAnyCalls.length, 0)
    // auto：立即刷新一次，URL 集合 = [priceUrl, priceFallbackUrl]（去重保序）。
    const realSetInterval = global.setInterval
    let capturedDelay = null
    global.setInterval = (fn, ms) => {
      capturedDelay = ms
      const t = realSetInterval(() => {}, 1_000_000)
      t.unref?.() // 假 timer 不许挂住进程退出
      return t
    }
    try {
      startPricingRefresh(noopCtx, {
        ...config.cost,
        priceSource: 'auto',
        priceUrl: 'https://a.test/p.json',
        priceFallbackUrl: 'https://b.test/p.json',
        priceRefreshHours: 7,
      }, cache)
    } finally {
      global.setInterval = realSetInterval
    }
    assert.equal(refreshAnyCalls.length, 1)
    assert.deepEqual(refreshAnyCalls[0], ['https://a.test/p.json', 'https://b.test/p.json'])
    assert.equal(capturedDelay, 7 * 3_600_000) // priceRefreshHours → 刷新周期
  })

  // ── t000036：压缩比例参与标注（**不参与 severity 阶梯**）────────────────
  await check('S3: 压缩比例只标注、不移 severity 档（t000036）', () => {
    // 压缩比例高**不改档位**：压缩后上下文变小 ⇒ 容量维反而转绿，
    // 升档会与容量信号自相矛盾；且压缩比例高常是容量压力的**结果**，
    // 独立计分＝同一事实算两次。
    const compressed = {
      turns: 1, userMessages: 0, assistantMessages: 0, compactions: 1,
      // 压缩后压力很小 ⇒ 占用极低（容量维 green）
      pressureTokens: 50_000, contextWindow: 1_000_000, compressionRatio: 0.8,
    }
    const v = healthView(compressed, config)
    assert.equal(v.severity, 'green', '压缩比例 0.8 不得把档位抬上去')
    assert.equal(v.compressionRatio, 0.8)
    // 档位不变，但标注更响：≥high → 「已大量摘要化」
    assert.ok(v.advice.includes('已大量摘要化'), v.advice)
    assert.ok(v.advice.includes('需复核'), v.advice)
    // 对照：同样的压缩比例但没有该信号 ⇒ 档位与标注都不该变
    const noCompaction = healthView({ ...compressed, compressionRatio: null }, config)
    assert.equal(noCompaction.severity, 'green')
    assert.ok(!noCompaction.advice.includes('摘要化'))
  })

  await check('S3: 压缩比例标注分三档，阈值可配（compressionRatioMid/High）', () => {
    const base = {
      turns: 1, userMessages: 0, assistantMessages: 0, compactions: 1,
      pressureTokens: 50_000, contextWindow: 1_000_000,
    }
    // 低档（< mid）：只报数字，不加措辞。
    const low = healthView({ ...base, compressionRatio: 0.1 }, config)
    assert.ok(low.advice.includes('上次压缩比例 ≈ 10%'), low.advice)
    assert.ok(!low.advice.includes('摘要化'), low.advice)
    // 中档（≥ mid）：「部分摘要化」
    const mid = healthView({ ...base, compressionRatio: 0.35 }, config)
    assert.ok(mid.advice.includes('早期细节部分摘要化'), mid.advice)
    // 重档（≥ high）：「已大量摘要化」
    const high = healthView({ ...base, compressionRatio: 0.6 }, config)
    assert.ok(high.advice.includes('早期细节已大量摘要化'), high.advice)
    // 阈值可配：把 mid 抬到 0.4 ⇒ 0.35 掉回低档
    const shifted = healthView({ ...base, compressionRatio: 0.35 }, resolveConfig({ thresholds: { compressionRatioMid: 0.4, compressionRatioHigh: 0.5 } }))
    assert.ok(!shifted.advice.includes('摘要化'), shifted.advice)
    // 把 high 压到 0.3（mid 0.2）⇒ 0.35 落进重档
    const stricter = healthView({ ...base, compressionRatio: 0.35 }, resolveConfig({ thresholds: { compressionRatioMid: 0.2, compressionRatioHigh: 0.3 } }))
    assert.ok(stricter.advice.includes('已大量摘要化'), stricter.advice)
  })

  await check('S3: 压缩比例标注在所有档位都出现，且不掩盖档位理由', () => {
    // 标注是「附带信息」：档位自己的理由必须在（容量/经济/消息数），
    // 压缩比例的措辞不能把它顶掉。
    const yellowByCapacity = {
      turns: 1, userMessages: 0, assistantMessages: 0, compactions: 1,
      pressureTokens: 600_000, contextWindow: 1_000_000, compressionRatio: 0.9,
    }
    const y = healthView(yellowByCapacity, config)
    assert.equal(y.severity, 'yellow')
    assert.ok(y.advice.includes('上下文已占窗口 60%'), y.advice)
    assert.ok(y.advice.includes('已大量摘要化'), y.advice)
    // 无压缩信号 ⇒ 不出现任何压缩措辞
    const none = healthView({ ...yellowByCapacity, compressionRatio: null }, config)
    assert.equal(none.severity, 'yellow')
    assert.ok(!none.advice.includes('摘要化'), none.advice)
  })
}
