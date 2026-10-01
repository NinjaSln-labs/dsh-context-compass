/**
 * dsh-context-compass — overview panel visual matrix.
 *
 * The panel is fully data-driven by POST /context-compass-rpc, so mocking
 * that route makes every pixel reproducible: 明/暗主题 × 四档（红黄蓝绿 +
 * 未知）矩阵 + 分页/排序交互 + 固定 5 行高度回归。
 */
import { test, expect } from '@playwright/test'
import { FIVE_TIER_ROWS, SIX_ROW_PAYLOAD, rpcPayload } from '../fixtures/overview.mjs'
import { mockOverview, openOverview, setTheme, settle, gotoApp, pinHostFontSize } from '../helpers.mjs'

test.beforeEach(async ({ page }) => {
  await gotoApp(page)
})

test('panel light: 四档矩阵 + 固定 5 行高度 + 行序', async ({ page }) => {
  // 显式切浅色：此前本测试不设主题，依赖「宿主默认是浅色」——宿主主题存在用户
  // settings 里（本机为深色），于是拍出的 light 基线其实是深色图（与 dark 基线
  // 字节完全相同，2026-09-10 发现）。视觉断言必须自带主题前置。
  await setTheme(page, 'light')
  await mockOverview(page, rpcPayload(FIVE_TIER_ROWS))
  await openOverview(page)
  await settle(page)
  // 行序：红 → 黄 → 蓝 → 绿 → 未知（host 排序，5 行满一页）。
  const chips = page.locator('.sh-panel-row .sh-sev-chip')
  await expect(chips).toHaveCount(5)
  await expect(chips.nth(0)).toHaveText('尽快收尾')
  await expect(chips.nth(1)).toHaveText('建议收尾')
  await expect(chips.nth(2)).toHaveText('继续留意')
  await expect(chips.nth(3)).toHaveText('放心继续')
  await expect(chips.nth(4)).toHaveText('暂无数据')
  // 状态列覆盖三态：运行中 / 已加载 / 冷却（fixture 行程与 RPC mock 同步）。
  await expect(page.locator('.sh-panel-row').nth(0)).toContainText('运行中')
  await expect(page.locator('.sh-panel-row').nth(1)).toContainText('已加载')
  await expect(page.locator('.sh-panel-row').nth(2)).toContainText('冷却')
  // 固定 5 行高度：列表几何不得随行数变化（41px × 5 + 16px padding）。
  const box = await page.locator('.sh-panel-list').boundingBox()
  expect(Math.round(box.height)).toBe(41 * 5 + 16)
  await expect(page.locator('.sh-panel')).toHaveScreenshot('panel-light.png')
})

test('panel dark: 四档矩阵（暗色主题）', async ({ page }) => {
  await setTheme(page, 'dark')
  await pinHostFontSize(page) // setTheme 走过设置页，截图前再钉一次字号基线
  await mockOverview(page, rpcPayload(FIVE_TIER_ROWS))
  await openOverview(page)
  await settle(page)
  await expect(page.locator('.sh-panel')).toHaveScreenshot('panel-dark.png')
})

test('panel: 分页 + 时间排序', async ({ page }) => {
  await mockOverview(page, rpcPayload(SIX_ROW_PAYLOAD))
  await openOverview(page)
  await settle(page)
  // 6 行 → 两页；第 2 页只剩「暂无数据」行。
  await expect(page.locator('.sh-panel-row')).toHaveCount(5)
  await page.locator('.sh-pager-btn[aria-label="下一页"]').click()
  await expect(page.locator('.sh-panel-row')).toHaveCount(1)
  await expect(page.locator('.sh-panel-row .sh-sev-chip')).toHaveText('暂无数据')
  // 切「活动」排序（按上次使用；mock 行无 updatedAt → 回退 createdAt）：
  // 时间最新在前（green2=600, unknown=500, green=400,
  // yellow=300, blue=200）→ 回到第 1 页（changeSort 重置页码）。
  await page.locator('.sh-col-head[aria-label="按上次使用排序"]').click()
  await expect(page.locator('.sh-panel-row')).toHaveCount(5)
  await expect(page.locator('.sh-panel-row .sh-sev-chip').first()).toHaveText('放心继续')
  await expect(page.locator('.sh-panel-row .sh-sev-chip').nth(1)).toHaveText('暂无数据')
  // 再切回严重度排序：红行回到首位。
  await page.locator('.sh-col-head[aria-label="按健康状态排序"]').click()
  await expect(page.locator('.sh-panel-row .sh-sev-chip').first()).toHaveText('尽快收尾')
})

test('panel: Esc 关闭 + 遮罩点击关闭', async ({ page }) => {
  await mockOverview(page, rpcPayload(FIVE_TIER_ROWS))
  await openOverview(page)
  await settle(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.sh-panel')).toBeHidden()
  await openOverview(page)
  await settle(page)
  await page.locator('.sh-scrim').click({ position: { x: 10, y: 450 } })
  await expect(page.locator('.sh-panel')).toBeHidden()
})

// 字号适配（表格部分）：宿主/浏览器的文字缩放会把整页放大。固定列宽 +
// overflow-wrap:anywhere 在这种条件下会把「已加载」折成两行。浮层那半在本套件
// 里测不了——panel spec 不开会话、没有徽章可悬停，它在 badge.spec.mjs。
test('面板：文字放大后单元格不得折行', async ({ page }) => {
  await setTheme(page, 'light')
  await openOverview(page)
  await mockOverview(page, rpcPayload(FIVE_TIER_ROWS))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openOverview(page)

  for (const zoom of [1, 1.5]) {
    await page.evaluate((z) => { document.body.style.zoom = z === 1 ? '' : String(z) }, zoom)
    await settle(page)

    // 列必须真的展开：所有格子左边缘相同时差值也会是 0，那是表格塌成一列，
    // 不是对齐。先断言「有 7 个不同的 x」，再断言表头与行逐列对齐。
    const xs = await page.evaluate(() => {
      const left = (el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left))
      return {
        head: left(document.querySelector('.sh-panel-head-row')),
        body: left(document.querySelector('.sh-panel-row')),
      }
    })
    expect(new Set(xs.body).size, `zoom=${zoom}：表格必须展开成多列（塌成一列时差值也会是 0）`).toBe(7)
    expect(xs.head.map((v, i) => v - xs.body[i]), `zoom=${zoom}：表头与行必须逐列对齐`).toEqual([0, 0, 0, 0, 0, 0, 0])

    // 不允许出现「接近两倍行高」的单元格——那正是折行的特征。
    // 注意不能断言各格行高相等：严重度那格是带 padding/边框的 chip，本就更高。
    const cells = await page.locator('.sh-panel-row').first().evaluate((row) =>
      [...row.children].map((c) => Math.round(c.getBoundingClientRect().height)))
    const lo = Math.min(...cells)
    const hi = Math.max(...cells)
    expect(hi, `zoom=${zoom}：面板单元格不得折行（最高 ${hi} vs 最低 ${lo}）`).toBeLessThan(lo * 1.6)

    await page.evaluate(() => { document.body.style.zoom = '' })
  }
})
