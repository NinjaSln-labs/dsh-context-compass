/**
 * dsh-context-compass — visual-regression helpers.
 *
 * Shared page choreography against the LIVE harness GUI (DSH_WEB_URL):
 * open a materialized session (the header badge only renders for one),
 * switch light/dark theme through Settings, and mock the overview RPC so
 * the panel matrix is deterministic.
 *
 * Selectors: the app's CSS-module class hashes change between builds, so
 * session rows are matched by the stable-ish `sessionRow` substring and the
 * composer by tag (the app has exactly one textarea).
 */
import { expect } from '@playwright/test'

/**
 * Navigate to the app shell.
 * dsh web 无登录、靠启动时打印的一次性 `?token=` 换 cookie（无 token → 401）；
 * baseURL 拼相对路径时 query 会被丢掉，所以带 token 的入口必须整串导航一次
 * （303 + Set-Cookie 之后，后续相对导航即可复用 cookie）。所有 spec 走这里。
 */
export async function gotoApp(page) {
  const entry = process.env.DSH_WEB_URL
  if (entry !== undefined && entry.includes('token=')) {
    await page.goto(entry, { waitUntil: 'domcontentloaded' })
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // 等 shell 挂载再往下走：主题/侧栏都是启动后异步施加的，早读早写都会踩竞态
  // （0.12.2 实测：setTheme 在此前读 body 属性，读到的还是默认值 → 提前 return →
  //  截图时应用才施加持久化的深色主题 → light 基线比对失败）。
  await expect(page.locator('button:has-text("设置"), button:has-text("Settings")').first())
    .toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(400) // 主题在 shell 挂载后再落定
}

/**
 * 侧栏里「一个真实会话」的可见入口——两种侧栏形态都认：
 * - 扁平列表：`div.sessionRow`（「新建会话」占位除外）；
 * - 工作区分组树（0.1.5-rc.1 起默认形态）：会话折叠在 `div.projectRow` 工作区节点下，
 *   必须先展开某个工作区，其内的 `sessionRow` 才会渲染。
 * 徽章只为**已物料化**的会话渲染，所以这一步是 badge spec 的前置。
 */
async function revealSessionEntry(page) {
  const realRows = () => page.locator('div[class*="sessionRow"]').filter({ hasNotText: /新会话|New Session/ })
  if (await realRows().count() > 0) return realRows().first()
  const projects = page.locator('div[class*="projectRow"]')
  const n = await projects.count()
  for (let i = 0; i < n; i++) {
    await projects.nth(i).click()
    await page.waitForTimeout(400)
    if (await realRows().count() > 0) return realRows().first()
  }
  return realRows().first() // 交给调用方的 expect 报清晰的「找不到会话」错误
}

/** Wait for the app shell, then open a real (non-new) session. */
export async function openSession(page) {
  await gotoApp(page)
  // 已经有会话物料化（徽章已渲染）就不用再点。
  if (await page.locator('.sh-badge').count() > 0) return
  const row = await revealSessionEntry(page)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(page.locator('.sh-badge')).toBeVisible({ timeout: 20_000 })
}

/** Idempotent theme switch through Settings → 外观（浅色/深色 | Light/Dark）. */
export async function setTheme(page, theme) {
  const wantDark = theme === 'dark'
  const isDark = () => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  // 先等主题落定（应用启动后异步施加），否则会读到默认值而误判「已是目标态」。
  await page.waitForFunction(() => document.readyState === 'complete').catch(() => {})
  await expect(page.locator('.sh-badge, [role="treeitem"], div[class*="sessionRow"]').first())
    .toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(300)
  if ((await isDark()) === wantDark) return
  const trigger = page.locator('button:has-text("设置"), button:has-text("Settings")').first()
  await trigger.click()
  const target = page
    .locator(`button:has-text("${wantDark ? '深色' : '浅色'}"), button:has-text("${wantDark ? 'Dark' : 'Light'}")`)
    .first()
  await expect(target).toBeVisible({ timeout: 10_000 })
  await target.click()
  if (wantDark) {
    await page.waitForSelector('body[data-ds-dark-theme]', { timeout: 10_000 })
  } else {
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'), { timeout: 10_000 })
  }
  // 断言真的落定——截图测试拿错主题时要当场炸，而不是拍出一张错主题的图去比基线。
  if ((await isDark()) !== wantDark) {
    throw new Error(`setTheme(${theme}) 未生效：body[data-ds-dark-theme] 与目标不一致`)
  }
  // Close the settings panel so it never overlaps the sidebar/panel.
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
}

/** Intercept the overview RPC with a deterministic payload. */
export async function mockOverview(page, payload) {
  await page.route('**/context-compass-rpc', route => {
    if (route.request().method() === 'POST') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      })
    } else {
      void route.continue()
    }
  })
}

/** Open the overview panel through the sidebar-foot action. */
export async function openOverview(page) {
  await page.locator('.sh-fa').first().click()
  await expect(page.locator('.sh-panel')).toBeVisible({ timeout: 10_000 })
}

/** Wait out the .15s entrance animations so screenshots are settled. */
export async function settle(page) {
  await page.waitForTimeout(350)
}
