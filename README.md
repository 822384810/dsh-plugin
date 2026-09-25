# dsh-plugin

DSH 插件工作区（仓库外插件，pnpm workspace）。目录布局：

```
…\deepseek-harness\            ← IDE 工作区
├── deepseek-harness\          ← harness 源码 checkout（仅作为插件的运行宿主）
└── dsh-plugin\                ← 本工作区
    ├── pnpm-workspace.yaml
    └── plugins/session-persona-manager/
```

## 目录

- [与 harness checkout 的关系](#与-harness-checkout-的关系)
- [术语：面（"半区"）/ 条目 / 层](#术语面半区-条目-层)
- [插件](#插件)
- [共享包与使用约定](#共享包与使用约定)
- [常用命令](#常用命令)
- [本地调试](#本地调试)
- [参考外部文档时的 API 对照](#参考外部文档时的-api-对照)
- [版本与宿主对齐（重要）](#版本与宿主对齐重要)
- [License](#license)

## 与 harness checkout 的关系

`dsh-plugin` 是 harness 仓库的**兄弟目录**，不在它的 pnpm workspace glob 内，因此：

- **构建/依赖/发布都不依赖 harness**：本工作区自带 esbuild 构建，`@deepseek-ai/*` 只声明为 `peerDependencies`，运行时由 profile 解析到运行中 dsh 的同一实例（`nodeLinker: hoisted` + `$DSH_HOME/profiles/node_modules` 回退）。
- **harness 只在“跑起来看效果”时用到**：它是插件的宿主（`dsh plugin add` / `--patch` / `dsh --profile <p>`）。
- 类型上插件用一份自包含的最小声明（`src/types.ts` + `src/shims.d.ts`），不 import harness 私有包。想获得完整类型时，可在本工作区临时把 `@deepseek-ai/*` link 到 checkout，但那会让项目重新耦合，默认不做。

## 术语：面（"半区"）/ 条目 / 层

**面（face）** = 同一个 npm 包在**两个不同运行环境**里的入口。本 README 有时也称"半区"，是沿用外部文档的叫法；harness 仓库自己的说法是 `Client/Host package` 与 `Host/Client activation`（`deepseek-harness/docs/subsystems/extensions.md`），以及 `Node face` / `browser half` / `build face`（`deepseek-harness/packages/client/AGENTS.md`）。查 harness 文档时按后面这些词搜。

| | Host 面（Node 面） | Client 面（browser half） |
|---|---|---|
| 跑在哪 | dsh 的 Node 进程（与 agent loop 同进程） | 浏览器页面 |
| 入口 / 产物 | `exports["."]` → `lib/index.js`（ESM） | `exports["./client"]` → `lib/client.js`（模块加载器包装的 CJS） |
| 挂载依据 | `cordis.patch.yml` 的一条 `insert` | `package.json` 的 `dsh.client.platform = "web"`，由 `window.__DSH_BOOT__` roster 扫描包名 |
| 可用的东西 | 全部 cordis 服务：`ctx.tools` / `ctx.systemPrompt` / `ctx.webServer` / `ctx.connection` / 会话事件 / fs / shell / LLM | 模块表（`react`、`react-dom`、`@deepseek-ai/cordis`、`client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`）+ inject 服务 + 插槽 |
| 跨面通信 | 注册带鉴权的 `/api` 精确 Fetch 路由（`ctx.connection.fetch.register`）、Typert Remote 契约 | `fetch('/api/…')`、`ctx.remote.*` |
| 改动生效 | **重启** profile 进程 | client-hmr **免刷新**热替换（见下"开发循环"） |

三个要点：

1. **两面不能互相 import 值**（只有 `import type` 可以）；行为走 inject 服务、UI 走插槽、数据走 `/api`、`rpc` 或 `ctx.remote.*`。
2. **只有 `./client` 导出并不会让浏览器加载它**：Client 面必须靠 `dsh.client` 声明 + roster 扫描（这就是 `--patch` 用 `file://` 时客户端不加载的原因）。
3. **一个包可以只有一面**：`plugins/llm-trace` 就是纯 Host 面插件（无 `dsh.client`，不产 `lib/client.js`）。

**条目（row）** 与 **层（layer）** 是组合侧的词，别和"面"混：

| 词 | 含义 | 决定什么 |
|---|---|---|
| 条目（row） | `cordis.patch.yml` 里的一条 `insert`（`id` + `name`） | 挂上哪个插件的 **Host 面** |
| 层（layer）/ 层包（bundle） | 声明了 `dsh.bundle.patch` 的包，提供一层 patch | 提供若干条目，按层顺序叠加 |
| profile | `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` | 层的叠加顺序（`dsh plugin add` 会往这里追加包名） |

**一句话**：面 = 同一包在两个运行环境的入口（代码跑在哪）；条目 = 组合树里的一个实例（谁被挂上来）；层 = 提供条目的叠加单元（按 profile 顺序叠）。

## 插件

| 插件 | 作用 |
|---|---|
| [`plugins/session-persona-manager`](plugins/session-persona-manager/README.md) | 会话级人格：工具 `manage_session_persona` + 按会话注入 system prompt + 会话头部 UI（双半区） |
| [`plugins/llm-trace`](plugins/llm-trace/README.md) | 把每次发给模型的完整请求（`system` + `messages` + `tools`）落盘成可读 JSON，用于核对提示词/人格是否真的进了请求（仅 Host 半区） |
| [`plugins/llm-wiki`](plugins/llm-wiki/README.md) | 知识库（Karpathy 三层：`raw/` 只读、`wiki/` 由 LLM 维护、`schema.md` 定规则）：多库注册表、摄入队列、混合检索、Agent 工具 + 斜杠命令 + 自动注入，以及侧边栏面板（双半区） |

## 共享包与使用约定

`packages/*` 是工作区内的**通用工具包**，所有插件统一使用。它们**源码直供**（`main`/`types` 指向 `src/index.ts`，没有构建产物），构建时由 esbuild **内联**进各插件的 `lib/` —— 因此**不单独发布**，也不会作为运行时依赖出现在消费方的 `node_modules`。

| 包 | 提供 | 约定（统一口径） |
|---|---|---|
| [`packages/time-utils`](packages/time-utils/README.md) | `now()` / `formatTimestamp(ts?)` / `Timestamp` | 时间只走本包：取当前时间 `now()`，格式化/持久化 `formatTimestamp()`。**禁止**直接调 `new Date()` / `Date.now()` / `toISOString()`。 |
| [`packages/result-utils`](packages/result-utils/README.md) | `ResultCode` / `Result<T>` / `reply()` / `unwrap()` | `/api` 路由返回值一律用统一信封 `{ code, msg, data }`：Host 用 `reply(ResultCode.OK, 'ok', data)`，浏览器用 `await unwrap<T>(await fetch(…))`。HTTP 状态恒 200，业务结果只看 `code`。**禁止**自造 `{ ok, value }` 之类的信封。 |
| [`packages/log-utils`](packages/log-utils/README.md) | `LogLevel` / `Logger` / `LoggerSink` / `LoggerOptions` / `createLogger(label, options?)` / `dshLogFile(name)` | 插件日志统一用 `createLogger('<plugin-name>', { sink: ctx.logger })`：每行 `[label]` 前缀，同时落到**终端**（宿主 `stderr` / 浏览器 `console`）、**日志文件**（默认 `$DSH_HOME/logs/<label>.log`）与**可选的 harness logger**。级别 `debug` / `info` / `warn` / `error`。**禁止**在业务代码里裸调 `console.*` / `process.stderr.write()`（像 `llm-trace` 那样刻意把 trace 结果写到 stderr 的输出除外）。 |

在新插件里接入（全部只写进 `devDependencies`，**不要**写 `dependencies`，否则发布包会带上本地 monorepo 依赖）：

```jsonc
"devDependencies": {
  "@dsh-plugins-xz/log-utils": "workspace:*",
  "@dsh-plugins-xz/plugin-kit": "workspace:*",
  "@dsh-plugins-xz/result-utils": "workspace:*",
  "@dsh-plugins-xz/time-utils": "workspace:*"
}
```

**为什么要统一**：口径一致（时间格式、接口线格式、日志前缀）；单一真源（改实现只改一处，例如把 `now()` 换成可注入时钟以便确定性测试）；消费方单包自包含（工具被内联进 `lib/`，用户只装插件本身）。新增通用工具请同样放进 `packages/<name>`，并在上表登记约定。

## 常用命令

```powershell
cd <dsh-plugin>

pnpm install          # 安装工作区依赖（pnpm 11 需在 pnpm-workspace.yaml 放行 esbuild 的构建脚本）
pnpm run typecheck    # 所有插件类型检查
pnpm run build        # 所有插件构建：lib/index.js（Host）+ lib/client.js（浏览器）
pnpm run check        # typecheck + build
pnpm run pack:all     # 生成 .tgz 到 ../../dist（发布前自检）
```

## 本地调试（两条路）

**A. 装进一个隔离 profile（推荐，双半区都生效）**

```powershell
# 在 harness checkout 里执行；persona-dev 从 web 模板初始化，不影响你的 web profile
cd <harness>
pnpm dsh --profile persona-dev --from-default-profile web --dump-config   # 只初始化，不启动
pnpm dsh plugin --profile persona-dev add <dsh-plugin>/dsh-plugins-xz-session-persona-manager-0.1.5.tgz
pnpm dsh --profile persona-dev            # 启动，浏览器打开它打印的 ?token=... URL
```

`dsh plugin add` 会把它加成 `link:` 依赖并把包名追加进该 profile 的 `dsh.profile.bundles`。

**B. `--patch` 覆盖层（只调试 Host 半区）**

```powershell
pnpm dsh web --patch D:\path\to\dev.patch.yml
```

覆盖层里 `name` 写 `file:///…/lib/index.js`（见插件内的 `cordis.patch.yml` 注释）。注意：file URL 没有包名，`__DSH_BOOT__` 扫描不到 `dsh.client`，**客户端半区不会加载**。

### 开发循环

| 改动 | 生效方式 |
|---|---|
| `src/client/**`（浏览器半区） | `pnpm --filter session-persona-manager run build` → `dsh web` 侧对 bundle 做 stat 轮询并广播 `rebuilt`，浏览器**免刷新**热替换（`@deepseek-ai/dsh-client-hmr`） |
| `src/**`（Host 半区） | 重启 profile 进程（Host 模块默认没有热加载） |
| `cordis.patch.yml` / profile 的 `cordis.patch.yml` | web 类 profile 为 `patchReload: live`，保存即重新组合 |

## 参考外部文档时的 API 对照（本仓库实测）

| 外部文档写法 | 本仓库真实 API |
|---|---|
| 插槽 `sidebar.session.row.action` | **不存在**（会话行菜单是硬编码的）。用 `conversation.session.header.actions`（list/session，能拿到 `sessionId`）或 `sidebar.footer.action`（list/root） |
| `ctx.pluginDataDir` | **不存在**。`$DSH_HOME/storages/<plugin>/…`（`dshHomePath()`）或 `ctx.storageDomain` |
| `ctx.webServer.get/post`（express 风格） | **不存在**。只有 `ctx.webServer.register({ kind: 'exact'\|'prefix', path, handler })`（node:http）；且自注册 `/api/*` **绕过**浏览器信任栅栏 —— 正确做法是 `ctx.connection.fetch.register({ path: '/api/<plugin>', methods, requestBody: 'buffered', fetch })`。注意：`ctx.connection.rpc.handle(...)` 在 out-of-tree 插件里**挂不上**（harness 用注册上下文自身的 fiber 解析 `webServer`，实测抛 `cannot get property "webServer" without inject`），不要用 |
| `exec.agent.sessionId`；`agent/created` 直接给 sessionId | `exec.agent.session`（Agent 对象）；`agent/created` payload 为 `{ agent, source }` |
| `systemPrompt.section({ content })` | 字段是 **`text`**；`order` 优先用 `ctx.systemPrompt.getSectionOrder(...)`（仓库内插件） |
| `dsh-plugin-create` / `scripts/auto-register.js` / `dsh-hot-reload` | **都不存在**。等价能力：手写包结构 + `dsh plugin add` + `@deepseek-ai/dsh-client-hmr` |
| `dsh.bundle.patch` | 真实存在，且是 `dsh plugin add` 识别插件的**唯一依据**（没有它只当普通依赖安装） |

## 版本与宿主对齐（重要）

**策略：下界开放、向上自动兼容，不写死。**

| 项 | 值 |
|---|---|
| 声明的下界 | `peerDependencies["@deepseek-ai/dsh"] = ">=0.1.7-rc.1"`（单一宿主版本约束；cordis / dsh-home-paths 等宿主包由运行时从宿主解析，不再作为版本门） |
| 运行时护栏 | `assertHostVersion()`：启动时读宿主 dsh 版本，**只有低于下界**才拒绝激活；更高版本（`0.1.7`、`0.2.0`…）一律放行，插件无需重发 |
| 单一真源 | 下界只在 `package.json` 写一次，由 `packages/plugin-kit/build-plugin.mjs` 的 `HOST_PEER` 读取，强制它必须是 `>=` 开头的开放下界，并注入产物为 `MINIMUM_HOST_VERSION` |

三条都跑过真实启动：

| 场景 | 结果 |
|---|---|
| 下界 ≤ 宿主（`>=0.1.7-rc.1` / 宿主 `0.1.7-rc.1`，即当前部署情形，下限等于宿主） | 静默通过，接口 200 |
| **下界低于宿主**（`>=0.1.7-rc.1` / 宿主 `0.1.8`，即后续升级的情形） | **静默通过**，接口 200 —— 升级宿主不用改插件 |
| 下界高于宿主（`>=0.1.7-rc.1` / 宿主 `0.1.6-alpha.1`，即"版本太低"） | 拒绝激活并点名：`host dsh 0.1.6-alpha.1 is older than the supported 0.1.7-rc.1; upgrade the host, or install a plugin build for that host`（宿主自身照常启动） |

三个坑：

1. **下界必须写成预发布形态**（`>=0.1.7-rc.1`）。若写成稳定的 `>=0.1.0`，semver 的预发布规则会让 `0.1.6-alpha.1` **不满足**该范围；pnpm 默认 `autoInstallPeers: true` 会真去 npm 解析同伴，于是直接 `ERR_PNPM_NO_MATCHING_VERSION` 构建失败。
2. **profile 里同伴依赖不被校验**（`autoInstallPeers: false` + `link:`，实测故意写错也静默通过），版本只能靠上面的运行时护栏兜底。
3. **别按 npm 的 `latest` 判断宿主版本**：`@deepseek-ai/dsh` 的 latest 目前是 `0.1.5-rc.1`、`dsh-home-paths` 停在老的 `0.0.1-rc.3` 线，而实际宿主 `0.1.6-alpha.1` 挂在 `alpha` 标签下。另外，若宿主未来改用**新 tuple 的预发布**（如 `0.1.7-alpha.1`），npm 的同伴检查仍可能报"不满足"（同一预发布规则）——运行时放行，但在纯 npm 环境安装会看到告警。

本工作区 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`：开发期不装同伴（避免上面的解析失败），类型来自包内最小声明。

## License

本项目以 [MIT 协议](./LICENSE) 发布。各发布包的 `package.json` 均声明 `"license": "MIT"`，使用即表示同意该协议条款。
