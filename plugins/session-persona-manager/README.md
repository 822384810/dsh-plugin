# session-persona-manager

会话级人格管理插件（Host + Client 双半区）：为人格建目录、把人格绑定到某个会话、在会话的 system prompt 里注入该人格，并提供浏览器入口。

## 注册了什么

| 面向 | 名称 | 位置 |
|---|---|---|
| 模型 | 工具 `manage_session_persona`（`get` / `set` / `list`） | `src/index.ts` |
| 模型 | system prompt 段 `session-persona-manager:persona`（绑定后按会话注入） | `src/index.ts`（注册在 `agent.ctx`，随该 agent 生命周期） |
| 浏览器 | `GET /api/session-persona-manager/personas` | 走 Connection 的鉴权栅栏 |
| 浏览器 | `GET\|POST /api/session-persona-manager/session` | 读取/写入会话绑定 |
| 浏览器 | 插槽 `conversation.session.header.actions` 的一个人格入口 | `src/client/index.tsx` |
| 浏览器 | locale 命名空间 `session-persona-manager`（zh/en） | `src/client/locales.ts` |

数据文件：`$DSH_HOME/storages/session-persona-manager/personas.json`（首次运行只写入默认人格；删除为软删除，记录 `status=0` 保留但不再列出，每条记录含 `createTime` / `updateTime` 两个时间字段，均为 ISO-8601 UTC 字符串（如 `2026-09-17T08:30:00.000Z`），由 `@dsh-plugins-xz/time-utils` 的 `formatTimestamp()` 统一生成）。

### 统一返回体

所有 `/api` 路由返回同一信封 `{ code, msg, data }`（定义于公共包 `@dsh-plugins-xz/result-utils`），HTTP 状态恒为 200，业务结果由 `code` 区分：

```ts
enum ResultCode { OK = 0, FAIL = 1, PARAM_ERR = 2, NO_LOGIN = 3, NO_AUTH = 4, EXCEPTION = -1 }
// { code: ResultCode, msg: string, data: T | null }
```

- 成功：`{ code: 0, msg: "ok", data: <载荷> }`；`GET /personas` 的 `data` 为 `PersonaView[]`，其余单条/绑定的 `data` 为 `PersonaView`，`session` 未绑定时 `data: null`，`delete` 成功时 `data: null`。
- 失败：`code` 取 `PARAM_ERR`（缺参/非法参数）、`FAIL`（业务找不到，如未知或被保留人格）、`EXCEPTION`（意外异常）；`msg` 为可读错误，`data` 恒为 `null`。
- 浏览器半区 `unwrap<T>()`（`src/client/index.tsx`）统一解析：非 2xx 或 `code !== 0` 时抛错，否则返回 `data`。

`PersonaView` 为 `{ id, name, content }`（不含 `createTime` / `updateTime` / `status`，由 `view()` 投影）。

## 目录

```
src/index.ts           Host 半区：工具 + prompt 注入 + /api 路由
src/store.ts           人格目录与会话绑定（内存缓存 + 写穿 JSON）
src/types.ts           自包含的最小 DSH 类型面（不 import harness 私有包）
src/shims.d.ts         运行时依赖的 harness 包的类型垫片
src/client/index.tsx   浏览器半区入口：注册插槽与文案
src/client/PersonaBar.tsx  会话头部的人格选择组件
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

## 打包（本地 / 发布 tarball）

`@dsh-plugins-xz/time-utils` 与 `@dsh-plugins-xz/result-utils` **不单独发布**：构建时由 esbuild 直接打包（bundle）进 `lib/index.js` / `lib/client.js`，用户只需安装 `@dsh-plugins-xz/session-persona-manager` 一个包即可，无需另行安装任何 `@dsh-plugins-xz/*`。它们只在 `devDependencies` 中以 `workspace:*` 声明，仅供本地 monorepo 内构建期链接；打包时由 `prepack` 钩子（`packages/plugin-kit/prepack.mjs`）把 `devDependencies`/`scripts` 从发布包 manifest 中剥离，因此最终产物是单包自包含的。

产出可分发包（内容由 `package.json` 的 `files` 决定：含 `lib/`、`cordis.patch.yml`、`README.md`）：

```powershell
cd <dsh-plugin>/plugins/session-persona-manager
pnpm run build    # 等价 node ../../packages/plugin-kit/build-plugin.mjs，构建 lib/
npm pack          # 生成 dsh-plugins-session-persona-manager-0.1.5.tgz
```

本地加载（无需 tarball，指向含 `cordis.patch.yml` 的源码目录即可）：

```powershell
dsh plugin --profile web add <dsh-plugin>/dsh-plugins-xz-session-persona-manager-0.1.5.tgz
```

或用刚生成的 tarball：

```powershell
dsh plugin --profile web add <dsh-plugin>/dsh-plugins-xz-session-persona-manager-0.1.5.tgz
```

## 验证人格确实进了模型请求

用同工作区的 [`llm-trace`](../llm-trace/README.md) 插件观察真实请求（`llm/stream` 事件 → 每次请求一个 JSON）：

```powershell
pnpm dsh plugin --profile <profile> add D:\…\dsh-plugin\plugins\llm-trace
pnpm dsh --profile <profile> "只回复：ok"        # 或 --session-id <id> 续跑
# 然后看 $DSH_HOME/logs/llm-trace/ 里最新的 JSON，检查 role=system 的消息
```

实测（本地 store 里 `concise` 的内容是 `你的名字叫：小简`）：

| 请求 | messages | system 字数 | 人格 |
|---|---|---|---|
| 新会话首次请求（该会话未绑人格） | 5 | 4278 | 无 |
| 同轮内 `manage_session_persona` 绑定后的下一次请求 | 7 | 4288 | **有**（`@112`，8 字 + 分隔换行） |
| `--session-id` 续跑已绑人格的会话 | 13 | 4288 | **有** |

结论与语义：

- prompt **按请求装配**，人格段落用 `text: () => …` 实时读取 store，所以**同会话 `set` 后，该轮的下一次请求就带上人格**（不是等下次会话）；
- 续跑会话会重新装配，同样生效；
- 未绑定人格时段落返回空串，不进入提示词（系统提示词长度不变）；
- 系统提示词在 `messages` 的 `system` 消息里（不在 `options.system`）。

## 实测过的行为

- 启动后 `GET /api/session-persona-manager/personas` → `200`，返回默认人格；
- 同一路由**不带**会话 cookie → `401`（说明路由确实在 Connection 的鉴权栅栏内）；
- `POST /api/session-persona-manager/session`（`{sessionId, personaId}`）→ `200`，随后 `GET` 读回同一人格（存储生效）；
- 启动日志无激活告警，`window.__DSH_BOOT__` 的启动组合里包含 `session-persona-manager/client.js`，并单独广告了 `/plugins/??session-persona-manager/client.js&rev=…`（客户端半区被发现并托管）。

未覆盖：真实模型调用下 system prompt 段与实际注入内容（需要一次带模型的会话）；建议在 UI 里绑定人格后发一条消息，用会话日志确认 `system/message` 里出现人格文本。

## 版本与宿主对齐（重要）

**策略：下界开放、向上自动兼容，不写死。**

| 项 | 值 |
|---|---|
| 声明的下界 | `peerDependencies["@deepseek-ai/dsh-home-paths"] = ">=0.1.5-rc.2"`；`@deepseek-ai/cordis` = `">=4.0.2"`（vendor 是独立版本线，不跟 dsh） |
| 运行时护栏 | `assertHostVersion()`：启动时读宿主 dsh 版本，**只有低于下界**才拒绝激活；更高版本（`0.1.7`、`0.2.0`…）一律放行，插件无需重发 |
| 单一真源 | 下界只在 `package.json` 写一次；`scripts/build.mjs` 强制它必须是 `>=` 开头的开放下界，并注入产物为 `MINIMUM_HOST_VERSION` |

三条都跑过真实启动：

| 场景 | 结果 |
|---|---|
| 下界 ≤ 宿主（`>=0.1.5-rc.2` / 宿主 `0.1.6-alpha.1`，即当前部署情形） | 静默通过，接口 200 |
| **下界低于宿主**（`>=0.1.5` / 宿主 `0.1.6-alpha.1`，即后续升级的情形） | **静默通过**，接口 200 —— 升级宿主不用改插件 |
| 下界高于宿主（`>=0.1.7` / 宿主 `0.1.6-alpha.1`，即"版本太低"） | 拒绝激活并点名：`host dsh 0.1.6-alpha.1 is older than the supported 0.1.7; upgrade the host, or install a plugin build for that host`（宿主自身照常启动） |

三个坑：

1. **下界必须写成预发布形态**（`>=0.1.5-rc.2`）。若写成稳定的 `>=0.1.0`，semver 的预发布规则会让 `0.1.6-alpha.1` **不满足**该范围；pnpm 默认 `autoInstallPeers: true` 会真去 npm 解析同伴，于是直接 `ERR_PNPM_NO_MATCHING_VERSION` 构建失败。
2. **profile 里同伴依赖不被校验**（`autoInstallPeers: false` + `link:`，实测故意写错也静默通过），版本只能靠上面的运行时护栏兜底。
3. **别按 npm 的 `latest` 判断宿主版本**：`@deepseek-ai/dsh` 的 latest 目前是 `0.1.5-rc.1`、`dsh-home-paths` 停在老的 `0.0.1-rc.3` 线，而实际宿主 `0.1.6-alpha.1` 挂在 `alpha` 标签下。另外，若宿主未来改用**新 tuple 的预发布**（如 `0.1.7-alpha.1`），npm 的同伴检查仍可能报"不满足"（同一预发布规则）——运行时放行，但在纯 npm 环境安装会看到告警。

本工作区 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`：开发期不装同伴（避免上面的解析失败），类型来自包内最小声明。

## 已知限制

- 样式使用内联样式而非 CSS Modules：CSS Modules 依赖 harness 内部的 tsdown 预设，仓库外插件默认不引它。若你愿意耦合 checkout，可改用 `x.module.css`。
- 没有为「会话行」提供入口：该插槽在 DSH 中不存在。当前入口在会话头部；如需行内菜单，只能整体接管 `sidebar.workspaces`。
- prompt 段的 `order` 用的是固定值 40（`ctx.systemPrompt.getSectionOrder(...)` 是仓库内插件的用法）。
- 版本不匹配时只有 **Host 半区**会拒绝激活；浏览器半区拿不到宿主版本，仍会加载并显示「读取人格失败」。要让 UI 也消失，需要在面板里对 `/api` 404 做降级处理（当前未实现）。
