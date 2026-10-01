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
 * 打开一个真会话，让 header 徽章有渲染时机。
 *
 * 为什么不用点侧栏（0.2.0-rc.2 实测）：
 *   - 侧栏工作区树能展开、会话搜索框在位，但 278 个已物料化会话一个都不显形，
 *     只剩 New Session 占位；点它、点顶部大按钮、试快捷键，UI 全无反应。
 *   - 宿主 `ctx.uiWorkspace.openSession(id)` 被正确调用（探针实证）也毫无反应。
 *   这些是宿主侧现象，本仓不自造绕行。
 *
 * 走的是宿主自己的会话契约键 `dsh.sessions.current`（客户端把当前会话记在
 * localStorage，见 dsh-client-ui-workspace 的 view store）。会话 id 由
 * `dsh --profile headless` 建出来——它既能接管已有会话也能新建，是当前唯一
 * 能在本 harness 产出可用会话的路径。
 *
 * 会话 id 来自 `DSH_VISUAL_SESSION_ID`；没给就现建一个（会跑一次 LLM 调用，
 * 故在套件注释与 README 里写明这处有代价，不要在 CI 里裸跑）。
 */
export async function openSession(page) {
  await gotoApp(page)
  if (await page.locator('.sh-badge').count() > 0) return

  const id = await resolveSessionId(page)
  await page.evaluate((sessionId) => {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
  }, id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.sh-badge')).toBeVisible({ timeout: 20_000 })
}

/** 解析要打开的会话 id：环境变量优先，否则用 headless profile 现建一个。 */
async function resolveSessionId(page) {
  if (process.env.DSH_VISUAL_SESSION_ID !== undefined && process.env.DSH_VISUAL_SESSION_ID !== '') {
    return process.env.DSH_VISUAL_SESSION_ID
  }
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('dsh', ['--profile', 'headless', '--json', '只回复两个字：收到'], {
    encoding: 'utf-8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
  })
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    if (evt.type === 'session' && typeof evt.sessionId === 'string') return evt.sessionId
  }
  throw new Error('dsh --profile headless 未返回 sessionId —— 无法准备徽章验收所需的会话')
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
