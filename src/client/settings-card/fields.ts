/** C2 配置卡片字段清单：path 化 FieldSpec + 嵌套读写纯函数。 */
export interface FieldSpec {
  /** settings 文档内嵌套路径，如 ['thresholds','windowMid']。 */
  path: string[]
  /** 表单控件种类。 */
  kind: 'number' | 'string' | 'boolean' | 'select' | 'strings'
  /** 渲染组（卡片分区标题）。 */
  group: '阈值' | '检查项' | '投影' | '计费'
  /** 控件 label（中文）。 */
  label: string
  /** 帮助文案（中文）；空串不显示。 */
  hint: string
  /** number 型的 0-1 比例标记；select 型的选项。 */
  min0max1?: boolean
  options?: readonly { value: string; label: string }[]
  /** restart-only 字段的说明。 */
  restartNote?: string
}

/** 嵌套读：沿 path 取 value；中间缺层返回 undefined。 */
export function readAtPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 嵌套 presence：user 层沿 path 是否 hasOwn（override 判定基础）。 */
export function hasAtPath(value: unknown, path: readonly string[]): boolean {
  if (value === undefined || value === null) return false
  let cur: unknown = value
  for (let i = 0; i < path.length; i++) {
    if (typeof cur !== 'object' || cur === null) return false
    const obj = cur as Record<string, unknown>
    if (!Object.hasOwn(obj, path[i])) return false
    if (i === path.length - 1) return true
    cur = obj[path[i]]
  }
  return false
}

/** 全量字段清单（硬编码 22 字段）。 */
export const FIELDS: readonly FieldSpec[] = [
  { path: ['thresholds', 'windowMid'], kind: 'number', group: '阈值', label: '蓝色档下限（windowMid）', hint: '窗口占比 ≥ 此值进入「继续留意」。默认 0.3。', min0max1: true },
  { path: ['thresholds', 'windowHigh'], kind: 'number', group: '阈值', label: '黄色档下限（windowHigh）', hint: '窗口占比 ≥ 此值进入「建议收尾」。默认 0.5。', min0max1: true },
  { path: ['thresholds', 'windowCritical'], kind: 'number', group: '阈值', label: '红色档下限（windowCritical）', hint: '窗口占比 ≥ 此值进入「尽快收尾」。默认 0.8。', min0max1: true },
  { path: ['thresholds', 'economyTokenFloor'], kind: 'number', group: '阈值', label: '经济档绝对下限（economyTokenFloor）', hint: '每轮计费当量超过此值（与窗口比例取较大者）进入经济维度。默认 50000。' },
  { path: ['thresholds', 'economyWindowRatio'], kind: 'number', group: '阈值', label: '经济档窗口比例（economyWindowRatio）', hint: '窗口占比组件：经济下限 = max(绝对下限, 此比例 × 窗口)。默认 0.3。', min0max1: true },
  { path: ['thresholds', 'economyRoundFloor'], kind: 'number', group: '阈值', label: '经济档剩余轮数（economyRoundFloor）', hint: '剩余轮数低于此值经济成本开始累积。默认 10。' },
  { path: ['thresholds', 'messageCountProxy'], kind: 'number', group: '阈值', label: '消息数代理下限（messageCountProxy）', hint: '消息数超过此值（与窗口比例取较大者）触发体积维度。默认 800。' },
  { path: ['thresholds', 'messageCountWindowRatio'], kind: 'number', group: '阈值', label: '消息数代理窗口比例（messageCountWindowRatio）', hint: '窗口比例组件。默认 0.002。', min0max1: true },
  { path: ['checks', 'git', 'enabled'], kind: 'boolean', group: '检查项', label: 'Git 探测', hint: '开关 git 工作区/未提交/分支状态探测。默认开。' },
  { path: ['checks', 'git', 'workspaceRoot'], kind: 'string', group: '检查项', label: 'Git 工作区根（可选）', hint: '留空则用会话 cwd。' },
  { path: ['checks', 'handoff', 'enabled'], kind: 'boolean', group: '检查项', label: '交接文档探测', hint: '开关 HANDOFF.md 探测。默认开。' },
  { path: ['checks', 'handoff', 'paths'], kind: 'strings', group: '检查项', label: '交接文档路径（可选）', hint: '逗号分隔；留空用默认名。' },
  { path: ['checks', 'sessionResume', 'enabled'], kind: 'boolean', group: '检查项', label: '会话续接探测', hint: '默认开。' },
  { path: ['checks', 'processes', 'enabled'], kind: 'boolean', group: '检查项', label: '进程探测', hint: '运行中进程检测。默认关。' },
  { path: ['checks', 'knowledge', 'enabled'], kind: 'boolean', group: '检查项', label: '知识库联动', hint: "探测 ctx.get('knowledge') 做跨会话回顾。默认开。" },
  { path: ['projection', 'enabled'], kind: 'boolean', group: '投影', label: '会话投影单元', hint: '关闭后徽章不再响应式（改配置时提示）。默认开。' },
  { path: ['cost', 'cacheHitDiscount'], kind: 'number', group: '计费', label: '缓存命中折扣（cacheHitDiscount）', hint: '命中 token 按全价的比例计费。默认 0.1。static/auto 回退的金额基准在挂载时冻结，改动需重启。', min0max1: true, restartNote: '需重启生效' },
  { path: ['cost', 'inputPricePerM'], kind: 'number', group: '计费', label: '输入价 USD/1M（inputPricePerM）', hint: 'static 模式或 auto 回退用的全价输入价。默认 0.28。挂载时冻结，改动需重启。', restartNote: '需重启生效' },
  { path: ['cost', 'priceSource'], kind: 'select', group: '计费', label: '价格来源（priceSource）', hint: 'auto=定时抓官方文档；static=用上值。', options: [
    { value: 'auto', label: 'auto（自动抓取官方定价）' },
    { value: 'static', label: 'static（固定值）' },
  ], restartNote: '需重启生效' },
  { path: ['cost', 'priceUrl'], kind: 'string', group: '计费', label: '主价格 URL（priceUrl）', hint: 'auto 模式主源。', restartNote: '需重启生效' },
  { path: ['cost', 'priceFallbackUrl'], kind: 'string', group: '计费', label: '备用价格 URL（priceFallbackUrl）', hint: 'auto 模式同轮回退。', restartNote: '需重启生效' },
  { path: ['cost', 'priceRefreshHours'], kind: 'number', group: '计费', label: '刷新周期小时（priceRefreshHours）', hint: 'auto 抓取间隔。默认 24。', restartNote: '需重启生效' },
]

/** 分组顺序 + 每组的显示标题。 */
export const GROUPS: readonly { key: string; title: string }[] = [
  { key: '阈值', title: '判定阈值' },
  { key: '检查项', title: '交接检查项' },
  { key: '投影', title: '投影单元' },
  { key: '计费', title: '计费与定价' },
]
