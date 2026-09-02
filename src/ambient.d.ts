/**
 * 集中加载宿主包的 Context 类型增强（ambient module augmentation）。
 *
 * dsh-settings / dsh-session-projection / dsh-client-runtime 等包在其
 * index.d.ts 里声明 `declare module '@deepseek-ai/cordis' { interface Context
 * { ... } }`——这类增强只在对应 .d.ts 被 tsc 纳入编译时全局生效。若源码
 * 不再显式 import 某包（如 v0.11.1 起 index.ts 不再 import dsh-settings，
 * 改用 ctx.inject），其增强会丢失，导致 `ctx.settings` / `ctx.remote` 等
 * 属性报错。此处用 side-effect import 让增强随构建注册，运行时无副作用。
 */

import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-api-remotes'
import '@deepseek-ai/dsh-client-runtime'
import '@deepseek-ai/dsh-client-runtime/client'
import '@deepseek-ai/dsh-client-ui-chat/client'
import '@deepseek-ai/dsh-client-ui-conversation'
import '@deepseek-ai/dsh-commands'
