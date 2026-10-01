/**
 * 集中加载宿主包的 Context 类型增强（ambient module augmentation）。
 *
 * dsh-settings / dsh-session-projection / dsh-client-ui-* 等包在其
 * index.d.ts 里声明 `declare module '@deepseek-ai/cordis' { interface Context
 * { ... } }`——这类增强只在对应 .d.ts 被 tsc 纳入编译时全局生效。若源码
 * 不再显式 import 某包（如 v0.11.1 起 index.ts 不再 import dsh-settings，
 * 改用 ctx.inject），其增强会丢失，导致 `ctx.settings` / `ctx.remote` 等
 * 属性报错。此处用 side-effect import 让增强随构建注册，运行时无副作用。
 */

import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-api-remotes'
// 0.2.0-rc.2：Context.slots / uiRenderer 由 client-ui-renderer 声明
// （旧的 client-runtime 传递链已随整包移除）。
import '@deepseek-ai/dsh-client-ui-renderer/client'
import '@deepseek-ai/dsh-client-ui-chat/client'
import '@deepseek-ai/dsh-client-ui-conversation'
import '@deepseek-ai/dsh-client-ui-primitives'
import '@deepseek-ai/dsh-client-ui-settings/client'
import '@deepseek-ai/dsh-commands'

// cordis-plugin-loader 在推进 volatile 单元后发出的变更通知。宿主侧实现在
// cordis-plugin-loader/lib/index.js 的 _commitVolatile，类型声明在同包
// lib/types/index.d.ts:29。本仓不直接依赖该包（只用它的事件名），故在此
// 就地声明，避免为一个事件引入运行时依赖。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 一次 volatile 配置写入后，变化的字段路径（逐段数组）。 */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}
