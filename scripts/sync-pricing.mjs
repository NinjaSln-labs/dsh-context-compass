/**
 * dsh-context-compass — 官方 DeepSeek 定价文档同步器（R3 / C4）。
 *
 * 做的事：`pricing/deepseek.json`（插件运行时金额显示的唯一数据源）从**人工手抄**
 * 变成**机器抓取 + 比对 + 开 PR**。
 *
 * 为什么没有官方 JSON feed：api-docs.deepseek.com 是 Docusaurus 站，只有
 * `/quick_start/pricing`（英文，USD）与 `/zh-cn/quick_start/pricing`（中文，CNY）
 * 两张 HTML 表格。故本脚本解析表格：英文页取 USD、中文页取 CNY，两边独立取数
 * 后**交叉校验**（峰谷时段必须换算后一致），任一页解析不出就**报错退出**——
 * 绝不写出一个「看起来合法但其实是静默降级」的定价文件。
 *
 * 官方价本身是两币种分列的（中文页 CNY、英文页 USD），**不做汇率换算**。
 *
 * 用法：
 *   node scripts/sync-pricing.mjs            # 只报告差异（人看）
 *   node scripts/sync-pricing.mjs --write    # 差异时改写 pricing/deepseek.json
 *   node scripts/sync-pricing.mjs --check    # 有差异则非零退出（CI 告警用）
 *
 * 退出码：0 = 一致（或 --write 后已写盘）；1 = 有差异且未写 / 抓取或解析失败。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PRICING_FILE = resolve(ROOT, 'pricing/deepseek.json')

export const EN_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const ZH_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** 官方页脚注：peak 时段（英文页写 UTC，中文页写北京时间）。 */
export const EN_PEAK_UTC_RE = /(\d{1,2}):(\d{2})\s*[-–—~]\s*(\d{1,2}):(\d{2})/g
export const ZH_PEAK_BJ_RE = /(\d{1,2}):(\d{2})\s*[-–—~]\s*(\d{1,2}):(\d{2})/g

const PERIOD_EN = { 'OFF-PEAK': 'offpeak', 'PEAK': 'peak' }
const PERIOD_ZH = { '空闲时段': 'offpeak', '高峰时段': 'peak' }
const METRIC_EN = { 'CACHE HIT': 'hit', 'CACHE MISS': 'miss' }
const METRIC_ZH = { '缓存命中': 'hit', '缓存未命中': 'miss' }

/** 输出 token 价不进本仓的定价文档（插件只算输入成本）——识别出来但跳过。 */
const SKIP_METRIC = /OUTPUT|输出/

/* ---------- HTML → 表格 → 单元格 ---------- */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function cellText(inner) {
  return decodeEntities(inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractTables(html) {
  const out = []
  const re = /<table\b[\s\S]*?<\/table>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const rows = []
    const rowRe = /<tr\b[\s\S]*?<\/tr>/gi
    let r
    while ((r = rowRe.exec(m[0])) !== null) {
      const cells = []
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
      let c
      while ((c = cellRe.exec(r[0])) !== null) cells.push(cellText(c[1]))
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 0) out.push(rows)
  }
  return out
}

/** 找承载价格的那张表：含 'PRICING' / '价格' 标记。 */
function pickPriceTable(tables, marker) {
  for (const rows of tables) {
    const flat = rows.flat().join(' | ')
    if (flat.includes(marker)) return rows
  }
  return null
}

/**
 * 从价格表里抽出 `{ model → { period → { miss, hit } } }`。
 *
 * 表格结构（官方页原样）：行首两列是 rowspan 合并的分组标签
 * （EN：`PRICING(2)` / `1M INPUT TOKENS(CACHE HIT)`；ZH：`价格(2)` / `百万tokens输入（缓存命中）`），
 * 后面是「时段 + 各模型价」。rowspan 让分组标签只在组的第一行出现 ⇒
 * **不能按固定列号取**，改为「先认出时段列，时段列之前那个非空标签＝本组指标，
 * 没有就沿用上一组的指标」。
 */
export function parsePriceTable(rows, opts) {
  const { periodMap, metricMap, priceRe, modelRe } = opts
  const header = rows.find((r) => r.filter((c) => modelRe.test(c)).length >= 2)
  if (!header) throw new Error('找不到模型表头行')
  // 表头模型名可能带脚注上标（如 `deepseek-flash(1)`）⇒ 剥掉脚注再作键。
  const models = header.filter((c) => modelRe.test(c)).map((c) => c.replace(/\(\d+\)$/, ''))

  const out = {}
  for (const m of models) out[m] = {}

  let metric = null
  for (const cells of rows) {
    const periodIdx = cells.findIndex((c) => periodMap[c.toUpperCase()] !== undefined || periodMap[c] !== undefined)
    if (periodIdx < 0) continue
    const period = periodMap[cells[periodIdx].toUpperCase()] ?? periodMap[cells[periodIdx]]
    const label = cells.slice(0, periodIdx).filter(Boolean).pop()
    if (label !== undefined && label !== '') metric = label
    if (metric === null) continue
    if (SKIP_METRIC.test(metric)) continue
    const key = Object.entries(metricMap).find(([needle]) => metric.includes(needle))?.[1]
    if (!key) continue
    const prices = cells.slice(periodIdx + 1)
    prices.forEach((cell, i) => {
      const model = models[i]
      if (model === undefined) return
      const m2 = priceRe.exec(cell)
      if (!m2) return
      const value = Number(m2[1])
      if (!Number.isFinite(value)) return
      out[model][period] ??= {}
      out[model][period][key] = value
    })
  }
  return { models, prices: out }
}

function toBeijing(utcHours) {
  return (utcHours + 8) % 24
}

/** 从英文页脚注取 peak 时段（UTC → 北京时间）。 */
export function parsePeakHoursUtc(text) {
  // 脚注(2)：「Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday…」
  // ⇒ 以「Peak hours are」为锚点往后取（表格里没有「Peak hours」字样，锚点安全）。
  const anchor = text.indexOf('Peak hours are')
  if (anchor < 0) throw new Error('英文页未找到「Peak hours are」表述')
  const scope = text.slice(anchor, anchor + 200)
  const windows = []
  for (const m of scope.matchAll(EN_PEAK_UTC_RE)) {
    windows.push([toBeijing(Number(m[1])), toBeijing(Number(m[3]))])
  }
  if (windows.length === 0) throw new Error('英文页未找到 peak 时段（UTC 表述）')
  return windows
}

/** 从中文页正文取 peak 时段（已是北京时间）。 */
export function parsePeakHoursBeijing(text) {
  // 脚注(2)：「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段」
  // ⇒ 以「北京时间」为锚点往后取；表格里也有「高峰时段」字样，故不能拿它当锚。
  const anchor = text.indexOf('北京时间')
  if (anchor < 0) throw new Error('中文页未找到「北京时间」表述')
  const scope = text.slice(anchor, anchor + 200)
  const windows = []
  for (const m of scope.matchAll(ZH_PEAK_BJ_RE)) {
    windows.push([Number(m[1]), Number(m[3])])
  }
  if (windows.length === 0) throw new Error('中文页未找到 peak 时段（北京时间表述）')
  return windows
}

/* ---------- 组装与比对 ---------- */

function round(n) {
  // 价格按官方原文的精度保留（0.003 这类三位小数），只消掉浮点毛刺。
  return Number(n.toFixed(6))
}

/**
 * 由两页解析结果组装定价文档。
 *
 * `models` 键 = 官方列出的模型 + 官方注明的**旧名别名**（英文页注(1)：
 * `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用，但按 Flash 价计费）
 * + `*` 兜底（取 Flash 价，未知模型按 Flash 计价）。
 */
export function buildDocument(en, zh) {
  const windows = en.peakHours
  const aliasNote = en.legacyAliases
  const models = {}

  const priceOf = (parsed, model, period) => parsed.prices[model]?.[period] ?? {}

  const primary = en.models[0]
  for (const model of en.models) {
    models[model] = {}
    for (const period of ['peak', 'offpeak']) {
      const usd = priceOf(en, model, period)
      const cny = priceOf(zh, model, period)
      if (usd.miss === undefined || cny.miss === undefined) {
        throw new Error(`模型 ${model} 的 ${period} 价格缺失（USD=${usd.miss} CNY=${cny.miss}）`)
      }
      models[model][period] = {
        inputMissPerMCny: round(cny.miss),
        inputHitPerMCny: round(cny.hit ?? 0),
        inputMissPerMUsd: round(usd.miss),
        inputHitPerMUsd: round(usd.hit ?? 0),
      }
    }
  }
  // 旧名别名：官方说旧名仍可调用、按 Flash 价计费。
  for (const alias of aliasNote) {
    if (models[alias] === undefined) models[alias] = structuredClone(models[primary])
  }
  models['*'] = structuredClone(models[primary])

  const note = [
    '官方峰谷定价（CNY 来自中文页、USD 来自英文页，均为官方价，无需汇率换算）。',
    `高峰 = 北京时间 ${windows.map(([a, b]) => `${a}:00-${b}:00`).join('、')}，其余闲时半价。`,
    '价格变更时更新本文件（同时更新 updatedAt）——由 scripts/sync-pricing.mjs 自动同步，勿手改。',
  ].join('')

  return {
    source: 'https://api-docs.deepseek.com/quick_start/pricing/',
    updatedAt: null, // 由调用方填今天
    peakHours: windows,
    models,
    note,
  }
}

/** 官方页注(1)：旧模型名仍可调用，按 Flash 价计费。 */
export function parseLegacyAliases(text) {
  const aliases = []
  const re = /`?(deepseek-[a-z0-9.-]+)`?/gi
  for (const m of text.matchAll(re)) {
    const name = m[1]
    if (name.includes('-v4-flash') && name !== 'deepseek-v4-flash' && name !== 'deepseek-v4-flash-vision-exp') continue
    if (name === 'deepseek-v4-flash' || name === 'deepseek-v4-flash-vision-exp') aliases.push(name)
  }
  return [...new Set(aliases)]
}

/**
 * 序列化成稳定格式（**可 diff**）。
 *
 * 为什么不用 `JSON.stringify(doc, null, 2)`：它把 `peakHours` 摊成 8 行、
 * 把 `3.0` 写成 `3` ⇒ 每次同步都是几十行噪声 diff，评审时真正变的
 * （价格数字）被淹没。这里固定两条规则：
 * - `peakHours` 单行（`[[9, 12], [14, 18]]`）
 * - 数字**至少一位小数**（`3` → `3.0`，与官方页写法一致）
 * ⇒ 同步后若价格没变，文件**逐字节不变**。
 */
export function formatDocument(doc) {
  const num = (n) => {
    const s = String(n)
    return s.includes('.') || s.includes('e') ? s : `${s}.0`
  }
  // ⚠ 缩进按**嵌套深度**算：模型名缩进 4、时段 6、字段 8（原文件就是这个形状）。
  const onePeriod = (name, p) => [
    `      "${name}": {`,
    `        "inputMissPerMCny": ${num(p.inputMissPerMCny)},`,
    `        "inputHitPerMCny": ${num(p.inputHitPerMCny)},`,
    `        "inputMissPerMUsd": ${num(p.inputMissPerMUsd)},`,
    `        "inputHitPerMUsd": ${num(p.inputHitPerMUsd)}`,
    `      }`,
  ].join('\n')
  const period = (price) => [
    onePeriod('peak', price.peak),
    onePeriod('offpeak', price.offpeak),
  ].join(',\n')
  const models = Object.entries(doc.models).map(([name, price]) =>
    `    ${JSON.stringify(name)}: {\n${period(price)}\n    }`)
  return [
    '{',
    `  "source": ${JSON.stringify(doc.source)},`,
    `  "updatedAt": ${JSON.stringify(doc.updatedAt)},`,
    `  "peakHours": [${doc.peakHours.map(([a, b]) => `[${a}, ${b}]`).join(', ')}],`,
    '  "models": {',
    models.join(',\n'),
    '  },',
    `  "note": ${JSON.stringify(doc.note)}`,
    '}',
  ].join('\n')
}

/** 比对两个文档（忽略 updatedAt），返回差异描述。 */
export function diffDocuments(current, next) {
  const diffs = []
  if (JSON.stringify(current.peakHours) !== JSON.stringify(next.peakHours)) {
    diffs.push(`peakHours: ${JSON.stringify(current.peakHours)} → ${JSON.stringify(next.peakHours)}`)
  }
  const modelNames = [...new Set([...Object.keys(current.models ?? {}), ...Object.keys(next.models)])].sort()
  for (const model of modelNames) {
    const a = current.models?.[model]
    const b = next.models?.[model]
    if (a === undefined) { diffs.push(`新增模型 ${model}`); continue }
    if (b === undefined) { diffs.push(`移除模型 ${model}`); continue }
    for (const period of ['peak', 'offpeak']) {
      for (const field of ['inputMissPerMCny', 'inputHitPerMCny', 'inputMissPerMUsd', 'inputHitPerMUsd']) {
        if (a[period]?.[field] !== b[period]?.[field]) {
          diffs.push(`${model}.${period}.${field}: ${a[period]?.[field]} → ${b[period]?.[field]}`)
        }
      }
    }
  }
  return diffs
}

/* ---------- 抓取与主流程 ---------- */

function pageText(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: 'text/html' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return await res.text()
}

/** 抓两页 → 解析 → 组装。任一步失败即抛（调用方决定退出码）。 */
export async function fetchDocument(fetchImpl = fetch, today) {
  const enHtml = await fetchText(EN_URL, fetchImpl)
  const zhHtml = await fetchText(ZH_URL, fetchImpl)

  const enRows = pickPriceTable(extractTables(enHtml), 'PRICING')
  const zhRows = pickPriceTable(extractTables(zhHtml), '价格')
  if (!enRows) throw new Error('英文页未找到价格表')
  if (!zhRows) throw new Error('中文页未找到价格表')

  const modelRe = /^deepseek-[a-z0-9.-]+(\(\d+\))?$/
  const en = parsePriceTable(enRows, {
    periodMap: PERIOD_EN,
    metricMap: METRIC_EN,
    priceRe: /^\$([\d.]+)$/,
    modelRe,
  })
  const zh = parsePriceTable(zhRows, {
    periodMap: PERIOD_ZH,
    metricMap: METRIC_ZH,
    priceRe: /^¥?([\d.]+)元$/,
    modelRe,
  })
  if (en.models.length === 0 || zh.models.length === 0) throw new Error('价格表里没认出模型列')
  if (JSON.stringify(en.models) !== JSON.stringify(zh.models)) {
    throw new Error(`两页模型不一致：EN=${en.models} ZH=${zh.models}`)
  }

  const enText = pageText(enHtml)
  const zhText = pageText(zhHtml)
  const peakHours = parsePeakHoursUtc(enText)
  const zhWindows = parsePeakHoursBeijing(zhText)
  if (JSON.stringify(peakHours) !== JSON.stringify(zhWindows)) {
    throw new Error(`两页 peak 时段换算后不一致：EN(UTC→BJ)=${JSON.stringify(peakHours)} ZH(BJ)=${JSON.stringify(zhWindows)}`)
  }

  const doc = buildDocument(
    { ...en, peakHours, legacyAliases: parseLegacyAliases(enText) },
    { ...zh, peakHours: zhWindows, legacyAliases: [] },
  )
  doc.updatedAt = today
  return doc
}

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const check = args.includes('--check')
  const today = new Date().toISOString().slice(0, 10)

  const current = JSON.parse(await readFile(PRICING_FILE, 'utf8'))
  let next
  try {
    next = await fetchDocument(fetch, today)
  } catch (err) {
    console.error(`✗ 抓取/解析失败：${err instanceof Error ? err.message : String(err)}`)
    console.error('  ⇒ 定价文件保持原样（不做任何降级改写）。')
    // 退出码 2 ＝ **抓取/解析失败**（与「有差异」的 1 区分开）——
    // CI 靠这个区分「官方页变了」与「官方页读不到」：前者开 PR，后者 job 直接红。
    process.exit(2)
  }

  const diffs = diffDocuments(current, next)
  if (diffs.length === 0) {
    // updatedAt 的语义＝「价格最后一次**内容**变化的日期」⇒ 价格没变就不动它，
    // 否则每次定时跑都会产生一次无意义改写（而内容一字未变）。
    console.log('✓ 定价文档与官方一致，无需改动。')
    return
  }
  // ⚠️ 差异**含 updatedAt 之外的一切**：模型增删也算（官方改版换模型名时
  // 旧条目就该被删掉，否则插件会继续按已下线模型计价）。
  console.log(`定价差异（${diffs.length} 处）：`)
  for (const d of diffs) console.log(`  · ${d}`)

  if (check) {
    console.error('✗ 定价文档已与官方脱节（--check 模式不改写）。')
    process.exit(1)
  }
  if (!write) {
    console.log('\n（未指定 --write，文件未改动）')
    return
  }
  await writeFile(PRICING_FILE, `${formatDocument(next)}\n`, 'utf8')
  console.log(`\n✓ 已写盘：${PRICING_FILE}（updatedAt=${today}）`)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main()
}
