# AGENTS（AI 协作与工程纪律）

## 项目概览

仓库根即插件目录（独立单库）。功能与使用介绍见 `README.md`；分支、提交、验证、发版规范见下与 `CONTRIBUTING.md`。

## 提交规范

- Conventional Commits 前缀 + 中文描述：`feat(scope):` / `fix(scope):` / `refactor:` / `docs:` / `test:` / `chore:`；scope 用模块名；发布提交固定 `chore: release v<版本> — <一句话主旨>`。
- 提交前跑 `npm run test`（build→typecheck→smoke→mount→client-mount，CI 与本地同源）并全绿。

## AI 协作守则（agent 贡献者必读）

1. 不猜 API/契约：写代码前用宿主或依赖的检查工具查精确签名；测试 stub 按真实契约形状写（失真 stub 会掩盖契约 bug，曾两次因此让契约 bug 潜伏三个版本）。
2. 完成的定义 = 验证链全绿 + 实机/测试验收，不是「代码写完」；声称完成前附验证输出。
3. 机密红线：本机绝对路径（`/home/<user>`、`/mnt/<盘>`、`/Users/<user>`）、个人邮箱、token/密钥、会过时的部署实况描述（"当前 profile 装的是 X 版本"一类）不入库；本机特有配置文件（如 `.githooks/commit-msg`）只留本地并 ignore。末尾目录名（无完整路径）不构成泄露。提交前 `git grep -nE '/home/[a-z]|/mnt/[a-z]|/Users/[a-z]'` 自查。
4. 不静默绕过门禁：pre-commit/CI FAIL 先修根因；确需跳过必须留痕注明。
5. 改动最小化：不顺手重构、不改无关文件；`lib/`、`visual/results/`、`audit-report/` 不入库，`package-lock.json` 入库。
6. 文档同步：行为或接口变化同步 `README.md`、`README.en.md`、`DEVELOPMENT.md` 速查表。
7. 用户显式指示优先于本文件，冲突点在 PR 或提交说明标注。

## 部署纪律

1. 改了本插件源码（`src/`、`lib/`）未发版 → profile 必须以 `file:` 指向本目录安装，禁止留在 registry 安装（同版本号不同内容，版本校验失效）。
2. 安装一律走 `dsh plugin --profile web install`，禁裸 `npm install`。
3. 每次 install / build 后必跑：`npm run check:deploy`（本单库即一个插件，无需 --pkg；FAIL 必须修复）。
4. `file:` 场景禁止手动软链。
5. 改完插件重启 dsh 才生效。host 源码改动后跑完整 `npm run build`，只跑 tsc 产出的 `lib/client.js` 是坏的。

本仓不是 pnpm workspace：monorepo 时代的 `pnpm-workspace.yaml` + `overrides` 防双实例护栏不适用；peer 兼容由宿主 dsh 决定，`peerDependencies` 如实声明即可。git 钩子在 `.githooks/`，启用 `git config core.hooksPath .githooks`。事故背景见 `DEVELOPMENT.md`「部署纪律：profile 安装」。

## 交接纪律

未决项真源是 `.handoff/`（本机私有、不入库）。路线与被阻塞项登记在 `docs/ROADMAP.md`（R3–R6 / B1–B2），它作为 `scope` 登记的活体源参与对账；交接真源仍只有 `.handoff/`。

- 记未决：`python3 <project-handoff>/scripts/handoff.py add action --…`，不手改 `.handoff/` 下的文件。
- 改插件后更新交接：`set status` / `set summary` / `set exit`（单文件槽整体覆写，写前先读回全量）。
- 交接前门禁：`handoff check` 通过且 `handoff confirm` 判卷 PASS。
- 放不进九槽的信息写 `unconfirmed`。
