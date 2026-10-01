/**
 * dsh-context-compass — S1 live 契约检查（contract-check）。
 *
 * 对运行中的真 harness 断言插件仍挂载、Host 半注入链路可用。DSH 处在 rc
 * 阶段，契约可能持续变动，因此本脚本只依赖一个稳定事实：插件注册的
 * `/context-compass-rpc` 路由（loopback-only）只在 Host 半成功挂载 +
 * webServer 注入成功时才存在；overview handler 内部真实调用注入服务
 * （sessionQuery / sessionProjectionCache / workspaceRegistry / sessions /
 * agents / sessionTitle）。
 *
 * 判别器（对应 src/overview.ts 的响应语义）：
 *   - 404                          → 路由不存在 → 插件未挂载/挂载失败（升级 API 漂移）
 *   - 400 "invalid json"           → 路由是插件 handler 的 → 挂载 + webServer 注入成功
 *   - 400 "unknown method"         → handler 派发逻辑活着
 *   - 200 { ok:true, result.sessions } → overview 注入服务链真实可用
 *   - 连接被拒（ECONNREFUSED）      → harness 未运行 → 跳过（exit 2，非插件失败）
 *
 *   注入服务形状漂移时，插件按防御设计逐处降级（overview 仍返回 200），所以本
 *   脚本捕获的是「升级后插件整体未能挂载/路由丢失」这一最大漂移形态；这符合
 *   rc 阶段"能起作用即可"的要求。真正逐服务形状校验需人工扫描（见 ROADMAP 升级体检基线）。
 *
 *   node scripts/contract-check.mjs            # 默认 http://127.0.0.1:3080
 *   DSH_WEB_URL=... node scripts/contract-check.mjs
 */
import { request } from 'node:http'

const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const BASE_URL = new URL(base)

/**
 * 0.2.0-rc.2 起的入口鉴权是「一次性 token 换签名 cookie」（见宿主
 * dsh-client-connection/lib/index.js:391 `authorizeIndex`）：
 *   - 只有 `GET /` 且带恰好一个合法 `?token=` 才 303 下发 `Set-Cookie:
 *     dsh-auth-*`（HttpOnly/SameSite=Strict）并跳回 `./`；
 *   - 其余请求一律按「每请求校验 cookie」处理，无 cookie → 401/405。
 * 所以只把 DSH_WEB_URL 的 token 挂在请求 query 上是不够的：query 换不成
 * cookie，非 index 请求不会受理。必须先 GET 入口换 cookie，再带上它。
 */
let authCookie = ''

function httpGet(path) {
  return new Promise((resolve) => {
    const req = request(
      { hostname: BASE_URL.hostname, port: BASE_URL.port, path, method: 'GET' },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] }))
      },
    )
    req.on('error', (e) => resolve({ error: e }))
    req.end()
  })
}

async function authenticate() {
  // 无 token 可传时也 GET 一次入口：已有 cookie 的情形由调用方注入不了，
  // 但本地开发常见的是「只给了 DSH_WEB_URL 带 token」，故走交换流程。
  const r = await httpGet('/' + (BASE_URL.search || ''))
  if (r.error) return { ok: false, reason: r.error.code ?? 'connection failed' }
  const cookies = r.setCookie ?? []
  const c = cookies.find((s) => s.startsWith('dsh-auth-'))
  if (c) authCookie = c.split(';')[0]
  return { ok: Boolean(authCookie), status: r.status }
}

/** POST 一段原文 body（raw，非 JSON.stringify，用于测非法 JSON）。 */
function postRaw(path, raw) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: BASE_URL.hostname,
        port: BASE_URL.port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on('error', (e) => resolve({ error: e }))
    req.end(raw)
  })
}

/** GET 一个路径（只读；用于佐证路由存在，不带 body）。 */
function getRaw(path) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: BASE_URL.hostname,
        port: BASE_URL.port,
        path,
        method: 'GET',
        headers: authCookie ? { cookie: authCookie } : {},
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on('error', (e) => resolve({ error: e }))
    req.end()
  })
}

/** POST 一段 JSON body。 */
function postJson(path, payload) {
  return postRaw(path, JSON.stringify(payload))
}

// 路径可覆盖：不是为了改产物，而是为了让「路由不在」这条**失败分支**可被
// 端到端验证——否则它只是一段没人跑过的报错文案，坏了也没人知道。
//   DSH_RPC_PATH=/not-a-real-route node scripts/contract-check.mjs
const RPC = process.env.DSH_RPC_PATH || '/context-compass-rpc'
let failed = 0

function pass(name, detail) { console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
function fail(name, detail) { console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); failed++ }

async function main() {
  console.log(`\n=== dsh-context-compass live 契约检查 ===`)
  console.log(`目标 harness: ${base}\n`)

  // 0) 入口鉴权：token → 签名 cookie 交换（0.2.0-rc.2 契约，见 authenticate）。
  const auth = await authenticate()
  if (!auth.ok) {
    console.log(`⚠️  harness 未运行或未完成鉴权（${auth.reason ?? `入口返回 ${auth.status}，未签发 dsh-auth-* cookie`}）——跳过契约检查（exit 2，非插件问题）`)
    console.log('    提示：DSH_WEB_URL 需为 dsh web 启动时打印的带 token 入口 URL。')
    process.exit(2)
  }
  pass('入口鉴权', 'token → dsh-auth-* cookie 交换成功')

  // 1) 路由存在性。
  //
  // 0.2.0-rc.2 起**状态码已不能判别**：宿主对未注册路径也回 405（空 body），
  // 旧的「404 = 未挂载」判据直接失效。真正的判别依据是**响应体是否带我们
  // handler 自己的 JSON**——实测（已挂载态）：
  //
  //              POST                         GET
  //   我们的路由  400 {"error":"invalid json"}  405 {"error":"POST only"}
  //   不存在的路径 405 （空 body）              404 （空 body）
  //
  // 「POST only」是本插件 handler 自己的字符串，不可能与宿主响应撞车；而空 body
  // 是宿主的「路径不存在」。所以判据 = body 形状，与状态码无关，宿主改状态码也
  // 不会失效。先打一条随机对照路径，把「未注册」在本宿主上的实际长相记录下来，
  // 失败时报错才能直接告诉人该去看什么。
  const probe = await postRaw(RPC, '{ bad json')
  if (probe.error || probe.status === undefined) {
    console.log(`⚠️  harness 未运行（${probe.error?.code ?? 'connection failed'}）——跳过契约检查（exit 2，非插件问题）`)
    process.exit(2)
  }
  const ours = (r) => {
    if (r.body === undefined || r.body.trim() === '') return false
    try { return typeof JSON.parse(r.body)?.ok === 'boolean' } catch { return false }
  }
  const controlPath = `${RPC}-control-${process.pid}`
  const control = await postRaw(controlPath, '{ bad json')
  if (ours(control)) {
    // 对照路径居然也返回了 JSON —— 说明宿主在未知路径上也开始回 JSON 形状，
    // 此时 body 判据不再自洽（无法区分「我们的」与「宿主的」），必须当场说清，
    // 不能给出误导性的通过/失败。对照路径**应当**没有 JSON body。
    console.log(`⚠️  对照路径 ${controlPath} 也返回了 JSON（${control.status} ${control.body.slice(0, 80)}）`)
    console.log('    宿主在未注册路径上的响应形状已变，body 判据不再自洽——判别器需要重新取证。')
    process.exit(2)
  }
  if (!ours(probe)) {
    fail('插件 RPC 路由存在', `POST → ${probe.status} ${JSON.stringify(probe.body.slice(0, 80))}（无本插件 JSON 特征）`)
    console.log(`    对照：未注册路径在本宿主上是 ${control.status} 空 body。`)
    console.log('    优先查两处：① dsh 启动日志里本插件是否被 peer 兼容性闸门拒启；')
    console.log('    ② webServer 注入后 register() 是否真的注册了路由。')
    console.log('')
    process.exit(1)
  }
  if (probe.status === 400 && probe.body.includes('invalid json')) {
    pass('插件 RPC 路由存在', 'POST 非法 JSON → 400 "invalid json"（路由是插件的 handler；判据为 body 形状，非状态码）')
  } else {
    fail('插件 RPC 路由存在', `路由在（body 是本插件的 JSON），但非法 JSON 未被拒：${probe.status} ${probe.body.slice(0, 80)}`)
  }
  // 1b) 第二个独立信号：GET 应命中同一个 handler 并回它自己的 'POST only'。
  //     两个信号都指向 handler，才算「路由确实装在宿主上」。
  const getProbe = await getRaw(RPC)
  if (getProbe.status === 405 && getProbe.body.includes('POST only')) {
    pass('路由方法守卫', 'GET → 405 "POST only"（同一 handler，独立佐证）')
  } else {
    fail('路由方法守卫', `GET → ${getProbe.status} ${getProbe.body.slice(0, 60)}（期望 405 "POST only"）`)
  }

  if (failed) { console.log(''); process.exit(1) }

  // 2) handler 派发逻辑：未知 method → 400 "unknown method"。
  const unk = await postJson(RPC, { method: 'not-a-real-method' })
  if (unk.status === 400 && unk.body.includes('unknown method')) {
    pass('handler 派发逻辑', '未知 method → 400 "unknown method"')
  } else {
    fail('handler 派发逻辑', `未知 method → ${unk.status} ${unk.body.slice(0, 60)}`)
  }

  if (failed) { console.log(''); process.exit(1) }

  // 3) overview 服务链：{method:'overview'} → 200 ok:true + result.sessions 数组。
  //    时延预算 200ms（稳态首帧预算）：请求路径上只允许同步读，cold load 与
  //    listSessions 刷新一律后台化（stale-while-revalidate）。host 冷启动后的
  //    第一帧是唯一例外（缓存全空必须真查一次）——所以首查超预算时等 1s 重试
  //    一次：重试仍超预算才算退化。0.1.1 的 coldSnapshot/listSessions 都是重
  //    操作，插件若退化成"每帧等待"会稳定撞满 handler 的 10s abort——响应仍
  //    是 200（假阳性）。时延断言拦住一切"慢到影响体验"的静默降级。
  const measureOverview = async () => {
    const t = Date.now()
    const r = await postJson(RPC, { method: 'overview' })
    return { r, ms: Date.now() - t }
  }
  let { r: ov, ms: elapsedMs } = await measureOverview()
  let okOverview = ov.status === 200
  if (okOverview) {
    try { const j = JSON.parse(ov.body); okOverview = j?.ok === true && Array.isArray(j?.result?.sessions) } catch { okOverview = false }
  }
  if (okOverview && elapsedMs > 200) {
    // 冷启动豁免：等 1s 让 host 端缓存预热后重试一次。
    await new Promise(resolve => setTimeout(resolve, 1000))
    ;({ r: ov, ms: elapsedMs } = await measureOverview())
    okOverview = ov.status === 200
    if (okOverview) {
      try { const j = JSON.parse(ov.body); okOverview = j?.ok === true && Array.isArray(j?.result?.sessions) } catch { okOverview = false }
    }
  }
  if (okOverview && elapsedMs <= 200) {
    pass('overview 注入服务链', `POST {method:overview} → 200 ok:true + result.sessions[]（${elapsedMs}ms ≤ 200ms 预算）`)
  } else if (okOverview) {
    fail('overview 注入服务链', `200 但耗时 ${elapsedMs}ms > 200ms 预算（含冷启动重试）—— 缓存失效/请求路径被慢查询阻塞`)
  } else {
    fail('overview 注入服务链', `POST {method:overview} → ${ov.status} ${ov.body.slice(0, 80)}`)
  }

  console.log('')
  if (failed) {
    console.log(`❌ ${failed} 项失败 —— 升级漂移或挂载异常，禁止发布\n`)
    process.exit(1)
  } else {
    console.log(`✅ 全部通过 —— 插件在 ${base} 上挂载且注入链路可用\n`)
    process.exit(0)
  }
}

main()
