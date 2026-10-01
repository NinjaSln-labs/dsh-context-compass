/**
 * Smoke domain: util (formatCompact / formatUsd / formatCny / formatHitRate).
 * Checks moved verbatim from the monolith's first block (L35-63).
 */
import assert from 'node:assert/strict'
import { formatCompact, formatUsd, formatCny, formatHitRate } from '../../lib/util.js'
import { check } from './helpers.mjs'

export async function run() {
  await check('util: formatCompact round-overflow guard + scale boundaries', () => {
    assert.equal(formatCompact(999), '999')
    assert.equal(formatCompact(1000), '1K')
    assert.equal(formatCompact(999_499), '999K')  // rounds down
    assert.equal(formatCompact(999_500), '1M')  // round-overflow guard: never 1000K
    assert.equal(formatCompact(999_999), '1M')
    assert.equal(formatCompact(1_000_000), '1M')
    assert.equal(formatCompact(1_234_567), '1.2M')
    assert.equal(formatCompact(10_000_000), '10M')
  })

  // 回归：计费当量 = 未命中 + 命中×缓存折扣，是浮点，1000 以下原先原样透出
  // （用户截图里是「约 595.490909091 token/轮（计费当量）」）。token 数语义上是整数。
  await check('util: formatCompact 对 1000 以下的浮点取整', () => {
    assert.equal(formatCompact(595.490909091), '595')
    assert.equal(formatCompact(0.4), '0')
    assert.equal(formatCompact(0.6), '1')
    assert.equal(formatCompact(595.5), '596')   // .5 进位
    assert.equal(formatCompact(999.4), '999')
    assert.equal(formatCompact(12), '12')
    assert.equal(formatCompact(0), '0')
  })

  await check('util: money formatting boundaries', () => {
    assert.equal(formatUsd(0.02), '$0.02')
    assert.equal(formatUsd(45), '$45.00')
    assert.equal(formatUsd(99.99), '$99.99')
    assert.equal(formatUsd(100), '$100')
    assert.equal(formatUsd(1234.5), '$1235')
    assert.equal(formatCny(0.1), '¥0.10')
    assert.equal(formatHitRate(0.996), '100%')
  })

  await check('util: non-finite numbers render as — (defense in depth, never NaN leaks)', () => {
    assert.equal(formatUsd(NaN), '—')
    assert.equal(formatUsd(Infinity), '—')
    assert.equal(formatCny(NaN), '—')
    assert.equal(formatCompact(NaN), '—')
    assert.equal(formatCompact(Infinity), '—')
    assert.equal(formatHitRate(NaN), '—')
  })
}
