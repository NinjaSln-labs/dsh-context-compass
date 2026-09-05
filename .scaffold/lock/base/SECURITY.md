# 安全策略

## 报告漏洞

本插件**只读**地读取宿主 harness 数据与 git/进程状态，不涉及凭据管理，但仍有安全边界值得关注：

- **RPC 路由 `/context-compass-rpc`**：仅 loopback 可达（防 DNS rebinding 的 Host 校验 + fail-closed）。
- **配置值**：`checks` / `thresholds` / `cost` 来自 settings 或组合入口，无敏感字段。
- **依赖**：发布产物携带的最小依赖（schemastery / zod）。

若你发现漏洞或安全缺陷，**不要**公开 issue——直接发邮件到仓库维护者（见 package.json author），或到 GitHub 仓库 Security 标签页用私密漏洞报告。

## 响应

- 确认收到后 72 小时内回复。
- 严重漏洞优先修复并发布补丁版本。
