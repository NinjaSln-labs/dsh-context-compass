/**
 * dsh-context-compass — badge hover bridge + tooltip 可达性 e2e（只读）。
 *
 * 桥接层回归（0.5.5 的可达性契约）：徽章 ↔ 浮层空隙由隐形桥接层
 * （.sh-tip::before）接通，鼠标路径不断；键盘聚焦打开、移出子树才关。
 *
 * 只读约定：本套件不触发任何真实 /compass（那会往会话日志写卡片，
 * 污染用户会话）——卡片功能（折叠/时间标签/失败态）由 smoke 与
 * client-mount 的单测覆盖，视觉上由 panel 矩阵（RPC mock，只读）承担。
 *
 * 会话前置：见 helpers.mjs 的 openSession——宿主侧栏在本 harness 显不出
 * 已物料化会话，改走 `dsh.sessions.current` 契约键；会话 id 由
 * DSH_VISUAL_SESSION_ID 给，没给会现建一个（有 LLM 调用代价）。
 */
import { test, expect } from '@playwright/test'
import { openSession } from '../helpers.mjs'

test.beforeEach(async ({ page }) => {
  await openSession(page)
})

test('hover 桥接层：进浮层不断、移出才关；键盘聚焦可达', async ({ page }) => {
  const badge = page.locator('.sh-badge')
  const tip = page.locator('.sh-tip')
  // 悬停徽章 → 浮层出现。
  await badge.hover()
  await expect(tip).toBeVisible()
  // 鼠标沿徽章→浮层的路径连续移动（途经 .sh-tip::before 桥接空隙）→ 浮层保持。
  const box = await tip.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
  await expect(tip).toBeVisible()
  // 移出整个包装 → 250ms 延迟后消失。
  await page.mouse.move(12, 12)
  await expect(tip).toBeHidden({ timeout: 3000 })
  // 键盘：Tab 聚焦徽章 → 浮层打开；Tab 在浮层内可聚焦项间移动不关；
  // Tab 越过最后一个可聚焦项移出子树才关。
  await page.locator('.sh-badge').focus()
  await expect(tip).toBeVisible()
  // 0.7.11+ 浮层含多个可聚焦项（计费切换 / 更多详情 / 复制摘要）——数出
  // 总数，逐一 Tab 应在浮层内保持，越过最后一个才关闭。
  const focusables = await tip.locator('button, [tabindex="0"]').count()
  for (let i = 0; i < focusables; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(150)
    expect(await tip.isVisible(), `Tab #${i + 1} must stay inside the tooltip`).toBe(true)
  }
  // 越过最后一个可聚焦项 → 移出子树 → 关闭。
  await page.keyboard.press('Tab')
  await expect(tip).toBeHidden({ timeout: 3000 })
})

// B2/B3 浮层交互（更多详情折叠 + 复制按钮）——0.7.12 部署后启用（此前
// harness 跑 0.7.10 无 showMore/copy 控件时 skip）。全程只读：不触发
// /compass、不写会话日志（summary RPC 本身只读）。
test('浮层 B2/B3：更多详情折叠 + 复制交接摘要按钮', async ({ page }) => {
  const badge = page.locator('.sh-badge')
  const tip = page.locator('.sh-tip')
  await badge.hover()
  await expect(tip).toBeVisible()
  // B2：次要行（模型窗口/会话规模）默认折叠在「更多详情」。
  await expect(tip.locator('.sh-tip-more')).toBeVisible()
  await expect(tip.locator('.sh-tip-row', { hasText: '模型窗口' })).toBeHidden()
  await tip.locator('.sh-tip-more').click()
  await expect(tip.locator('.sh-tip-row', { hasText: '模型窗口' })).toBeVisible()
  await tip.locator('.sh-tip-more').click()
  await expect(tip.locator('.sh-tip-row', { hasText: '模型窗口' })).toBeHidden()
  // 已压缩是核心信号，不折叠（compactions > 0 时始终可见）。
  if (await tip.locator('.sh-tip-row', { hasText: '已压缩' }).count() > 0) {
    await expect(tip.locator('.sh-tip-row', { hasText: '已压缩' })).toBeVisible()
  }
  // B3：复制按钮存在；点击触发只读 summary RPC（不写会话日志），按钮短暂反馈。
  const copyBtn = tip.locator('.sh-tip-copy')
  await expect(copyBtn).toBeVisible()
  await copyBtn.click()
  await expect(copyBtn).toHaveText(/已复制/, { timeout: 10_000 })
})

// 字号适配（浮层部分）：文字放大后，浮层里的值不得从**词中间**断开。此前
// overflow-wrap:anywhere 会把「（缓存命中 0%）」拆成「（缓存命中」+「0%）」。
// 判定方式：多行渲染时，若每行宽度都远小于整块内容宽，说明是被硬切而非自然折行。
test('浮层：文字放大后值不得从词中间断开', async ({ page }) => {
  const badge = page.locator('.sh-badge').first()
  for (const zoom of [1, 1.5]) {
    await page.evaluate((z) => { document.body.style.zoom = z === 1 ? '' : String(z) }, zoom)
    await badge.hover()
    await expect(page.locator('.sh-tip')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(300)
    const broken = await page.locator('.sh-tip .sh-v').evaluateAll((els) =>
      els.filter((e) => {
        const rects = e.getClientRects()
        if (rects.length < 2) return false
        const widest = Math.max(...rects.map((r) => r.width))
        return widest < e.scrollWidth * 0.6
      }).map((e) => e.textContent?.trim().slice(0, 24)))
    expect(broken, `zoom=${zoom}：浮层值不得从词中间断开`).toEqual([])
  }
  await page.evaluate(() => { document.body.style.zoom = '' })
})
