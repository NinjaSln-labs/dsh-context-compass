/**
 * Smoke domain: 定价同步器（scripts/sync-pricing.mjs）。
 *
 * 验三件事：
 * 1. **解析器**：官方页的表格结构（rowspan 分组、时段列、脚注上标模型名）能正确抽出
 *    模型 → 时段 → 价格；peak 时段能从两页脚注各取一份并换算成一致。
 * 2. **健壮性**：页面结构变了（缺表/缺列/价格格式变了）时**抛错**而不是静默产出
 *    错误定价——本仓的老病是「静默降级」，这里必须反过来。
 * 3. **在库文件合规**：pricing/deepseek.json 满足插件的文档契约（结构合法、
 *    双币齐全、峰谷时段合法），且与官方当前值一致（离线快照，防止手改漂移）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  extractTables,
  parsePriceTable,
  parsePeakHoursUtc,
  parsePeakHoursBeijing,
  parseLegacyAliases,
  diffDocuments,
  buildDocument,
  formatDocument,
} from '../sync-pricing.mjs'
import { check } from './helpers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 英文页价格表的最小 HTML（照官方 rowspan 结构抄，足够驱动解析器）。 */
const EN_HTML = `
<table>
<tr><td colspan="3">MODEL</td><td>deepseek-flash(1)</td><td>deepseek-v4-pro</td></tr>
<tr><td colspan="3">PRICING(2)</td><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td colspan="3">PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td colspan="3">1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td colspan="3">PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td colspan="3">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td colspan="3">PEAK</td><td>$1.2</td><td>$3.96</td></tr>
</table>
<p>(1) Use <code>deepseek-flash</code> as the model name. The legacy names <code>deepseek-v4-flash</code> and <code>deepseek-v4-flash-vision-exp</code> are still accepted.</p>
<p>(2) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday.</p>
`

/** 中文页价格表的最小 HTML。 */
const ZH_HTML = `
<table>
<tr><td colspan="3">模型</td><td>deepseek-flash(1)</td><td>deepseek-v4-pro</td></tr>
<tr><td colspan="3">价格(2)</td><td>百万tokens输入 （缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td colspan="3">高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td colspan="3">百万tokens输入 （缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td colspan="3">高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td colspan="3">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td colspan="3">高峰时段</td><td>8元</td><td>27.0元</td></tr>
</table>
<p>(2) 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段均为空闲时段。</p>
`

const MODEL_RE = /^deepseek-[a-z0-9.-]+(\(\d+\))?$/
const EN_OPTS = {
  periodMap: { 'OFF-PEAK': 'offpeak', 'PEAK': 'peak' },
  metricMap: { 'CACHE HIT': 'hit', 'CACHE MISS': 'miss' },
  priceRe: /^\$([\d.]+)$/,
  modelRe: MODEL_RE,
}
const ZH_OPTS = {
  periodMap: { '空闲时段': 'offpeak', '高峰时段': 'peak' },
  metricMap: { '缓存命中': 'hit', '缓存未命中': 'miss' },
  priceRe: /^¥?([\d.]+)元$/,
  modelRe: MODEL_RE,
}

function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

export async function run() {
  await check('sync-pricing: 英文页表格解析（模型 / 时段 / 价，脚注上标已剥离）', () => {
    const rows = extractTables(EN_HTML)[0]
    const parsed = parsePriceTable(rows, EN_OPTS)
    assert.deepEqual(parsed.models, ['deepseek-flash', 'deepseek-v4-pro'])
    const flash = parsed.prices['deepseek-flash']
    assert.equal(flash.offpeak.miss, 0.15) // 1M INPUT TOKENS (CACHE MISS) OFF-PEAK
    assert.equal(flash.offpeak.hit, 0.003) // 1M INPUT TOKENS (CACHE HIT) OFF-PEAK
    assert.equal(flash.peak.miss, 0.3)
    assert.equal(flash.peak.hit, 0.006)
    const pro = parsed.prices['deepseek-v4-pro']
    assert.equal(pro.offpeak.miss, 0.66)
    assert.equal(pro.peak.miss, 1.32)
    // 输出 token 价不进本仓定价文档（插件只算输入成本）⇒ 不得出现 output 指标。
    assert.equal(flash.output, undefined)
  })

  await check('sync-pricing: 中文页表格解析（CNY）', () => {
    const rows = extractTables(ZH_HTML)[0]
    const parsed = parsePriceTable(rows, ZH_OPTS)
    const flash = parsed.prices['deepseek-flash']
    assert.equal(flash.offpeak.miss, 1)
    assert.equal(flash.offpeak.hit, 0.02)
    assert.equal(flash.peak.miss, 2)
    assert.equal(flash.peak.hit, 0.04)
    assert.equal(parsed.prices['deepseek-v4-pro'].peak.miss, 9.0)
  })

  await check('sync-pricing: peak 时段两页各自解析且换算后一致', () => {
    const en = parsePeakHoursUtc(textOf(EN_HTML))
    const zh = parsePeakHoursBeijing(textOf(ZH_HTML))
    // EN 写 UTC 01-04 / 06-10 ⇒ 北京 09-12 / 14-18
    assert.deepEqual(en, [[9, 12], [14, 18]])
    assert.deepEqual(zh, [[9, 12], [14, 18]])
    assert.deepEqual(en, zh)
  })

  await check('sync-pricing: 旧模型名别名从官方脚注取出', () => {
    const aliases = parseLegacyAliases(textOf(EN_HTML))
    assert.deepEqual(aliases, ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
  })

  await check('sync-pricing: 组装出的文档含别名与 * 兜底，且峰谷时段一致', () => {
    const enRows = extractTables(EN_HTML)[0]
    const zhRows = extractTables(ZH_HTML)[0]
    const en = parsePriceTable(enRows, EN_OPTS)
    const zh = parsePriceTable(zhRows, ZH_OPTS)
    const doc = buildDocument(
      { ...en, peakHours: [[9, 12], [14, 18]], legacyAliases: parseLegacyAliases(textOf(EN_HTML)) },
      { ...zh, peakHours: [[9, 12], [14, 18]], legacyAliases: [] },
    )
    doc.updatedAt = '2026-01-01'
    assert.deepEqual(doc.peakHours, [[9, 12], [14, 18]])
    for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', '*']) {
      assert.ok(doc.models[model], `缺模型 ${model}`)
      for (const period of ['peak', 'offpeak']) {
        const p = doc.models[model][period]
        for (const f of ['inputMissPerMCny', 'inputHitPerMCny', 'inputMissPerMUsd', 'inputHitPerMUsd']) {
          assert.equal(typeof p[f], 'number', `${model}.${period}.${f} 必须是数字`)
        }
        // 官方「闲时价 = 高峰价的一半」⇒ 两币两指标都必须是高峰价的一半，否则解析错了列。
        const peak = doc.models[model].peak
        const off = doc.models[model].offpeak
        for (const f of ['inputMissPerMCny', 'inputHitPerMCny', 'inputMissPerMUsd', 'inputHitPerMUsd']) {
          assert.equal(off[f], peak[f] / 2, `${model}.${f} 闲时应为高峰的一半`)
        }
      }
    }
    // 别名与 * 兜底 = Flash 价（官方注(1)：旧名按 Flash 价计费）
    assert.deepEqual(doc.models['*'], doc.models['deepseek-flash'])
    assert.deepEqual(doc.models['deepseek-v4-flash'], doc.models['deepseek-flash'])
  })

  await check('sync-pricing: diff 抓得住每一处价格漂移与模型增删', () => {
    const a = {
      peakHours: [[9, 12]],
      models: { x: { peak: { inputMissPerMCny: 1, inputHitPerMCny: 0.1, inputMissPerMUsd: 0.2, inputHitPerMUsd: 0.02 }, offpeak: { inputMissPerMCny: 1, inputHitPerMCny: 0.1, inputMissPerMUsd: 0.2, inputHitPerMUsd: 0.02 } } },
    }
    const b = structuredClone(a)
    assert.deepEqual(diffDocuments(a, b), [])
    b.models.x.peak.inputMissPerMCny = 2
    b.peakHours = [[9, 12], [14, 18]]
    b.models.y = structuredClone(b.models.x)
    const diffs = diffDocuments(a, b)
    assert.equal(diffs.length, 3)
    assert.ok(diffs.some((d) => d.includes('peakHours')))
    assert.ok(diffs.some((d) => d.includes('inputMissPerMCny')))
    assert.ok(diffs.some((d) => d.includes('新增模型 y')))
  })

  await check('sync-pricing: 页面结构变化时抛错（不静默产出错误定价）', () => {
    // 缺模型表头 ⇒ 抛错
    assert.throws(() => parsePriceTable([['API', 'Unit', 'Price']], EN_OPTS), /找不到模型表头行/)
    // 价格格式变了（不再带 $）⇒ 抽不出价格 ⇒ 解析结果里没有该指标（不静默填 0）
    const broken = EN_HTML.replace(/\$/g, '')
    const rows = extractTables(broken)[0]
    const parsed = parsePriceTable(rows, { ...EN_OPTS, priceRe: /^\$([\d.]+)$/ })
    assert.equal(parsed.prices['deepseek-flash'].offpeak, undefined)
    // peak 脚注被删 / 锚点消失 ⇒ 解析器抛错（两种情形分别断言）
    assert.throws(() => parsePeakHoursUtc('Peak hours are gone'), /未找到 peak 时段/)
    assert.throws(() => parsePeakHoursUtc('the note was rewritten'), /Peak hours are/)
    assert.throws(() => parsePeakHoursBeijing('没有北京时间'), /北京时间/)  })

  await check('sync-pricing: 序列化稳定（同步两次逐字节相同，价格未变则文件不动）', async () => {
    const doc = {
      source: 'https://api-docs.deepseek.com/quick_start/pricing/',
      updatedAt: '2026-10-28',
      peakHours: [[9, 12], [14, 18]],
      models: {
        'deepseek-flash': {
          peak: { inputMissPerMCny: 2, inputHitPerMCny: 0.04, inputMissPerMUsd: 0.3, inputHitPerMUsd: 0.006 },
          offpeak: { inputMissPerMCny: 1, inputHitPerMCny: 0.02, inputMissPerMUsd: 0.15, inputHitPerMUsd: 0.003 },
        },
      },
      note: 'x',
    }
    const a = formatDocument(doc)
    const b = formatDocument(doc)
    assert.equal(a, b, '同一文档两次序列化必须逐字节相同')
    // 序列化结果必须是**合法 JSON**，且能原样 parse 回等价对象。
    const back = JSON.parse(a)
    assert.equal(back.models['deepseek-flash'].peak.inputMissPerMCny, 2)
    assert.equal(back.models['deepseek-flash'].peak.inputMissPerMUsd, 0.3)
    assert.deepEqual(back.peakHours, [[9, 12], [14, 18]])
    // 数字保留至少一位小数（与官方页写法一致）⇒ diff 里看得出「1 → 1.0」而非 1 → 1
    assert.ok(a.includes('"inputMissPerMCny": 2.0,'), a)
    assert.ok(a.includes('"inputMissPerMUsd": 0.3,'), a)
    // peakHours 单行（不摊成 8 行噪声）
    assert.ok(a.includes('"peakHours": [[9, 12], [14, 18]],'), a)
  })

  await check('sync-pricing: 库内 pricing/deepseek.json 满足插件文档契约', async () => {
    const doc = JSON.parse(await readFile(resolve(ROOT, 'pricing/deepseek.json'), 'utf8'))
    assert.ok(Array.isArray(doc.peakHours) && doc.peakHours.length > 0, 'peakHours 不能为空')
    for (const [start, end] of doc.peakHours) {
      assert.equal(typeof start, 'number')
      assert.equal(typeof end, 'number')
      assert.ok(start >= 0 && end > start && end <= 24, `peak 时段非法：${start}-${end}`)
    }
    assert.ok(doc.models && Object.keys(doc.models).length > 0, 'models 不能为空')
    for (const [model, price] of Object.entries(doc.models)) {
      for (const period of ['peak', 'offpeak']) {
        const p = price[period]
        assert.ok(p, `${model}.${period} 缺失`)
        for (const f of ['inputMissPerMCny', 'inputHitPerMCny', 'inputMissPerMUsd', 'inputHitPerMUsd']) {
          assert.equal(typeof p[f], 'number', `${model}.${period}.${f} 必须是数字`)
          assert.ok(Number.isFinite(p[f]) && p[f] >= 0, `${model}.${period}.${f} 非法`)
        }
        // 插件侧 validDocument 要求「未命中价 > 0」
        assert.ok(p.inputMissPerMCny > 0 && p.inputMissPerMUsd > 0, `${model}.${period} 未命中价必须 > 0`)
      }
    }
    assert.ok(doc.models['*'], '必须保留 * 兜底')
    assert.ok(typeof doc.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.updatedAt), 'updatedAt 必须是日期')
    // **插件的校验器必须认这份文件**（同一个 validDocument）⇒ 同步器产出的东西
    // 不会被运行时静默拒掉（那正是本仓的老病：写出来的东西运行时认不得）。
    const { PriceCache } = await import('../../lib/pricing.js')
    const cache = new PriceCache({ missPerMUsd: 0.28, hitPerMUsd: 0.028, missPerMCny: null, hitPerMCny: null, period: null })
    const ok = await cache.refresh('https://x', async () => ({ ok: true, json: async () => structuredClone(doc) }))
    assert.equal(ok, true, '插件的 validDocument 拒了同步器产出的文档')
    // 未知模型落到 * 兜底，且拿到 CNY 价（说明兜底条目真的被解析进去了）
    const p = cache.get('some-unknown-model')
    assert.equal(p.period !== null, true)
    assert.equal(typeof p.missPerMCny, 'number')
    assert.ok(p.missPerMCny > 0)
    // 库内文件的序列化形状与同步器一致（手改过格式也能被发现）
    assert.equal(formatDocument(doc), (await readFile(resolve(ROOT, 'pricing/deepseek.json'), 'utf8')).trimEnd())
  })
}
