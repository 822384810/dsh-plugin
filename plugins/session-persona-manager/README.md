# session-persona-manager

为每个会话单独设置人格（Persona），切换后从下一轮对话开始生效。
通过会话头部的 🎭 入口即可快速切换，人格配置持久化保存。

**核心特性：**
- **会话级隔离**：每个人格绑定到具体会话，互不影响
- **会话头部快捷入口**：在会话头部直接点击 🎭 切换人格
- **持久化存储**：重启 DSH 后会话人格选择自动恢复
- **动态注入**：人格在 Agent 作用域内注册，不污染全局配置

## 工作原理

`session-persona-manager` 复用了 DSH 的以下能力接缝：

| DSH 能力 | 插件用法 |
|---|---|
| `ctx.tools` 注册表 | 注册 `manage_session_persona` 工具 |
| `ctx.connection.fetch` | 在 Connection 鉴权栅栏内提供 `/api/session-persona-manager/personas` 与 `/api/session-persona-manager/session` HTTP 路由 |
| `ctx.systemPrompt.section()` | 在 agent 作用域内注入人格提示段 |
| 文件系统 | 人格映射持久化在插件数据目录 |

数据流：UI 选择人格 → HTTP 路由写入映射 → 会话启动时读取映射 → agent 作用域注册提示段。

## 安装

```bash
dsh plugin --profile web add @dsh-plugins-xz/session-persona-manager
```

## 注册了什么

| 面向 | 名称 | 位置 |
|---|---|---|
| 模型 | 工具 `manage_session_persona`（`get` / `set` / `list`） | `src/index.ts` |
| 模型 | system prompt 段 `session-persona-manager:persona`（绑定后按会话注入） | `src/index.ts`（注册在 `agent.ctx`，随该 agent 生命周期） |
| 浏览器 | `GET\|POST /api/session-persona-manager/personas` | 走 Connection 的鉴权栅栏（GET 列目录；POST 按 `op` 创建/更新/删除） |
| 浏览器 | `GET\|POST /api/session-persona-manager/session` | 读取/写入会话绑定 |
| 浏览器 | 插槽 `conversation.session.header.actions` 的一个人格入口 | `src/client/index.tsx` |
| 浏览器 | locale 命名空间 `session-persona-manager`（zh/en） | `src/client/locales.ts` |

数据文件：`$DSH_HOME/storages/session-persona-manager/personas.json`（首次运行只写入默认人格；删除为软删除，记录 `status=0` 保留但不再列出，每条记录含 `createTime` / `updateTime` 两个时间字段，均为 ISO-8601 UTC 字符串（如 `2026-09-17T08:30:00.000Z`），由 `@dsh-plugins-xz/time-utils` 的 `formatTimestamp()` 统一生成）。

## 数据结构

- `PersonaView`（API 投影，不含 `createTime` / `updateTime` / `status`）：`{ id, name, content }`。
- 存储见上文「注册了什么」：`$DSH_HOME/storages/session-persona-manager/personas.json`（首次运行只写入默认人格；删除为软删除，记录 `status=0`）。

## 目录

```
src/index.ts           Host 半区：工具 + prompt 注入 + /api 路由
src/store.ts           人格目录与会话绑定（内存缓存 + 写穿 JSON）
src/types.ts           自包含的最小 DSH 类型面（不 import harness 私有包）
src/shims.d.ts         运行时依赖的 harness 包的类型垫片
src/client/index.tsx   浏览器半区入口：注册插槽与文案
src/client/PersonaBar.tsx  会话头部的人格选择组件
src/client/PersonaManager.tsx  人格管理弹窗（新增 / 编辑 / 删除，由 PersonaBar 拉起）
packages/plugin-kit/build-plugin.mjs   esbuild：lib/index.js（ESM）+ lib/client.js（模块加载器包装）
cordis.patch.yml       bundle 层（package.json 的 dsh.bundle.patch 指向它）
```

## 构建与安装

```powershell
cd <dsh-plugin>
pnpm install
pnpm --filter session-persona-manager run build

# 装进隔离 profile（在 harness checkout 里执行）
cd ..\deepseek-harness
pnpm dsh --profile persona-dev --from-default-profile web --dump-config
pnpm dsh plugin --profile persona-dev add <dsh-plugin>/dsh-plugins-xz-session-persona-manager-0.1.5.tgz
pnpm dsh --profile persona-dev
```

改浏览器半区后：`pnpm --filter session-persona-manager run build`，浏览器会通过 client-hmr 免刷新热替换；
改 Host 半区后需要重启 `dsh --profile persona-dev`。

## 已知限制

- 样式使用内联样式而非 CSS Modules：CSS Modules 依赖 harness 内部的 tsdown 预设，仓库外插件默认不引它。若你愿意耦合 checkout，可改用 `x.module.css`。
- 没有为「会话行」提供入口：该插槽在 DSH 中不存在。当前入口在会话头部；如需行内菜单，只能整体接管 `sidebar.workspaces`。
- prompt 段的 `order` 用的是固定值 40（`ctx.systemPrompt.getSectionOrder(...)` 是仓库内插件的用法）。
- 版本不匹配时只有 **Host 半区**会拒绝激活；浏览器半区拿不到宿主版本，仍会加载并显示「读取人格失败」。要让 UI 也消失，需要在面板里对 `/api` 404 做降级处理（当前未实现）。
