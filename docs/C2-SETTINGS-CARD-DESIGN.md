# C2 设计定稿 — Client 配置卡片（`settings.plugin.item` keyed 自建）

> 状态：**已实施（0.12.0，2026-09-06）**。原方案（自建 RPC 转发 `settings-describe`/`settings-mutate`）经 5 轮评审后重写：宿主 `settingsScope.bind()` 直接支持多段 path mutate + revision fence，无需自建 RPC。实际实现见 `src/client/settings-card/`。
> 调研基准：harness `0.1.1-rc.2`（live）· `@deepseek-ai/dsh-settings@0.1.0-rc.6` · `@deepseek-ai/dsh-client-ui-settings@0.1.0-rc.6` · `@deepseek-ai/dsh-client-schema-form@0.1.0-rc.6` · `@deepseek-ai/dsh-client-ui-settings-plugins`（harness 内置，0.1.1-rc.2）
> 实施基准：harness `0.1.2-alpha.4` · `@deepseek-ai/dsh-client-ui-settings@0.1.2-alpha.4`（settingsScope 通道）
> 调研日期：2026-08-27

## 1. 背景与目标

C1 已把 host 配置点接入 settings namespace `'context-compass'`（嵌套 Config：`thresholds`×8 / `checks`×5 / `projection`×1 / `cost`×6，live 生效）。C2 提供浏览器侧的配置卡片，让设置 UI 直接调参，无需重启。

## 2. 调研事实（全部实测）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **`settings.plugin.item` 是 keyed slot，key = 卡片所编辑的 settings namespace；owner props 为空**（`SettingsPluginItemOwnerProps.children?: never`，卡片完全自包含、无 props） | dsh-client-ui-settings-plugins `lib/types/client/slot-contract.d.ts`（harness 内置） |
| F2 | **场外插件不可复用内置卡片的「外观与表单模型」**（bundle 纯净度门禁禁止以值导入）→ 卡片须**自建暂存 + revision 设栅**；但 field 覆盖语义、写入契约是公开的 | settings-plugins README「已知限制」 |
| F3 | **`ctx.settingsScope`（官方 client 传输）的 `set/unset` 只支持顶层标量字段**（`path: [field]` 单段）→ 不适合嵌套 Config（**事实仍真，但推论失效——见方案变更**） | dsh-client-ui-settings `lib/client.js` L78-96 |
| F4 | **Host `ctx.settings.mutate(ns, ops, expectedRevision)` 支持完整嵌套 path**（`['thresholds','windowMid']`）+ revision 乐观锁（`SettingsConflictError` code `SETTINGS_CONFLICT`，附 expected/actual） | dsh-settings `lib/types/index.d.ts` |
| F7 | **`settingsScope.bind({namespace})` 返回的 scope 对象，其 `mutate(ops, revision)` 的 `op.path` 是 `string[]` 多段**（宿主 `applyPathOp` 用 `[head,...rest]` 递归建中间对象）→ 绕过 F3 限制，无需自建 RPC | dsh-settings `lib/settings.js` 实证（card-form.ts 直接消费此通道） |
| F5 | **`@deepseek-ai/dsh-client-schema-form` 是纯模型层（无 React）**，且已在 build-client.mjs 的 EXTERNAL 表：`rehydrateSchema` / `validateDraft` / `nodeAtPath` / `setPath` / `deletePath` / `hasPath` / `getPath` —— 可复用做 schema 解析与草稿校验 | schema-form README + `package.json` |
| F6 | Host 侧已有 `/context-compass-rpc`（loopback-only）通道，`ctx.get('settings')` 在 webServer 子 context 可读到 settings 服务 | overview.ts + C1 §3.7 |

## 3. 设计

### 3.1 挂载点

`client.tsx` 新增 keyed slot 注册（owner props 为空，卡片无 props）：

```tsx
ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
  { name: 'settings.plugin.item', key: 'context-compass' } as never,
  () => <ContextCompassSettingsCard />,
) as never)
```

`key = 'context-compass'` 与 host namespace 同名——tab 靠这个 key 把「Host 注册的命名空间」与「浏览器注册的卡片」配对（F1）。

### 3.2 通道方案变更（实施时修正）

> **原设计**：扩展 `/context-compass-rpc`，加 `settings-describe` / `settings-mutate` 两个 method（3.2 节描述）。
> **实施方案**：5 轮评审后发现宿主 `settingsScope.bind()` 已内置多段 path mutate + revision fence（F7），无需自建 RPC。改为 client 侧直接 inject `settingsScope` 服务 → `bind({namespace:'context-compass'})` → `scope.mutate(ops, revision)`。
> **变更影响**：§2 事实 F3 的推论（"需 RPC 转发"）失效；F5（schema-form 复用）亦未采用（字段清单硬编码，官方 bash 卡同款 pattern）。自建 RPC 转发段（3.2）废弃，通道改走官方 settingsScope。

### 3.3 Client 卡片表单（实施方案）

组件通过 `settingsScope.bind({namespace:'context-compass'})` 拿 scope，不拉 descriptor：

1. **字段清单硬编码**（`src/client/settings-card/fields.ts`）：按 Config 分组手写 22 个 FieldSpec——
   - `thresholds`（8 项 number）：`windowMid / windowHigh / windowCritical / economyTokenFloor / economyWindowRatio / economyRoundFloor / messageCountProxy / messageCountWindowRatio`
   - `checks`（7 项）：`git.enabled`(bool) + `git.workspaceRoot`(string)、`handoff.enabled`(bool) + `handoff.paths`(strings)、`sessionResume.enabled`(bool)、`processes.enabled`(bool)、`knowledge.enabled`(bool)
   - `projection.enabled`(bool)
   - `cost`（6 项）：`cacheHitDiscount / inputPricePerM`(number)、`priceSource`(select auto/static)、`priceUrl / priceFallbackUrl`(string)、`priceRefreshHours`(number)
2. **草稿暂存**（`card-form.ts`）：`CompassCardForm` 类，判别联合 `{kind:'text'} | {kind:'bool'} | {kind:'clear'}`；parseField 范围校验（0-1 / 整数 / select 选项）；thresholdError 单调性（mid < high < critical）
3. **覆盖标记与重置**：`hasAtPath(user, path)` 判定字段是否被覆盖；「重置」= `{ op:'unset', path }` 回退到 composition base 层
4. **revision 设栅**：保存携带 scope 当前 `revision`；写失败（mutate 不 reject，但回读 user 层 missing）→ `failed=true`，草稿保留
5. **校验**：写前 parseField 拒非法（范围/选项）+ thresholdError 拒非单调；Host `validate` 兜底（单调性写时拒绝）

### 3.4 字段 → 写入 ops 映射

保存时把脏字段集合映射为 `ops`：

```ts
// 例：改了 windowMid + 开了 processes + 重置了 priceSource
ops = [
  { op: 'set',   path: ['thresholds', 'windowMid'],  value: 0.42 },
  { op: 'set',   path: ['checks', 'processes', 'enabled'], value: true },
  { op: 'unset', path: ['cost', 'priceSource'] },
]
```

## 4. 风险与未决（实施后状态）

| 风险 | 状态 |
|---|---|
| R1 `settings.plugin.item` 渲染上下文 | ✅ 已实测：卡片正常出现在设置 → 插件配置页 |
| R2 `rehydrateSchema` 执行 `new Function` | ✅ 不适用（方案改用硬编码 FieldSpec，不走 schema-form） |
| R3 `describe` schema 信封 | ✅ 不适用（方案改用硬编码 FieldSpec，不走 schema 解析） |
| R4 settings 未挂载（headless） | ✅ 已处理：`scope.getSnapshot().status === 'unavailable'` → 整卡 null |
| 新风险：`settingsScope` 注入死锁 | ✅ 已处理：client-mount stub 与 inject 变更同步加（见 pits） |
| 新风险：`mutate` 参数逆变 cast | ✅ 已处理：双 cast（as unknown as）保证通过，形状契约经实证 |

## 5. 实施记录（已落地，原计划废弃）

> 原定 3 任务切分（T1 host RPC / T2 client 组件 / T3 文档发版）已废弃。实际按重写版计划 `docs/superpowers/plans/2026-09-04-c2-settings-card.md` 的 Task 1-8 落地，最终交付 **0.12.0**。
>
> **实际 Task 对应**：
> - T1（依赖/类型面）：package.json peer/devDep + ambient.d.ts → commit `e77284e`
> - T2（Slot + inject + stub）：client.tsx SlotMap + inject + client-mount stub → commit `e77284e`
> - T3（fields.ts）：22 字段全量 + readAtPath/hasAtPath → commit `e77284e`
> - T4（card-form.ts）：CompassCardForm 草稿控制器 + parseField + thresholdError → commit `e77284e`
> - T5（index.ts）：createSettingsCard 组装 → commit `e77284e`
> - T6（card.tsx + styles.ts）：React UI + 官方壳样式 + 真组件注册 → commit `e77284e`
> - T7（集成验证）：file: 安装 + 本机实测（待浏览器验收）
> - T8（文档回填 + 发版）：README/ROADMAP/PUBLISHING/C2-DESIGN 更新 → 本 commit
