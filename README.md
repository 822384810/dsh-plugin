# dsh-plugin

DSH 插件工作区（仓库外插件，pnpm workspace）。目录布局：

```
…\deepseek-harness\            ← IDE 工作区
├── deepseek-harness\          ← harness 源码 checkout（仅作为插件的运行宿主）
└── dsh-plugin\                ← 本工作区
    ├── pnpm-workspace.yaml
    └── plugins/session-persona-manager/
```

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
| 跨面通信 | 注册 `/api` 路由、`rpc` channel、Typert Remote 契约 | `fetch('/api/…')`、`ctx.connection.rpc`、`ctx.remote.*` |
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

## 共享包

- [`packages/time-utils`](packages/time-utils/README.md)：所有插件统一使用的时间工具（`now()` / `formatTimestamp()`），作为时间戳的唯一真源。新增插件请勿直接 `Date.now()`，改为从本包导入，保证时间格式一致、将来可统一替换实现。
- [`packages/result-utils`](packages/result-utils/README.md)：所有插件统一的 HTTP 返回体 `{ code, msg, data }`（`ResultCode` 枚举 + `reply()` 构造 + `unwrap()` 解析），Host 与浏览器半区共用，保证接口线格式一致。

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
| `ctx.webServer.get/post`（express 风格） | **不存在**。只有 `ctx.webServer.register({ kind: 'exact'\|'prefix', path, handler })`（node:http）；且自注册 `/api/*` **绕过**浏览器信任栅栏 —— 正确做法是 `ctx.connection.fetch.register(...)` / `ctx.connection.rpc.handle(...)` |
| `exec.agent.sessionId`；`agent/created` 直接给 sessionId | `exec.agent.session`（Agent 对象）；`agent/created` payload 为 `{ agent, source }` |
| `systemPrompt.section({ content })` | 字段是 **`text`**；`order` 优先用 `ctx.systemPrompt.getSectionOrder(...)`（仓库内插件） |
| `dsh-plugin-create` / `scripts/auto-register.js` / `dsh-hot-reload` | **都不存在**。等价能力：手写包结构 + `dsh plugin add` + `@deepseek-ai/dsh-client-hmr` |
| `dsh.bundle.patch` | 真实存在，且是 `dsh plugin add` 识别插件的**唯一依据**（没有它只当普通依赖安装） |

## 版本对齐（写插件时最需要注意的一项）

- dsh 家族（`@deepseek-ai/dsh*`）**同版本发布**，本机 checkout 与 profile 实际加载的是 **`0.1.6-alpha.1`**；`@deepseek-ai/cordis` 是 vendor 独立线，当前 **`4.0.2`**。npm 的 `latest` 标签**落后**（`@deepseek-ai/dsh` → `0.1.5-rc.1`，`dsh-home-paths` → `0.0.1-rc.3`），判断宿主版本别看它。
- 插件采用**下界开放**策略：`peerDependencies` 写 `>=0.1.6-alpha.1`（不写上限、不写死），运行时只拒绝**低于下界**的宿主，更高版本自动兼容、无需重发插件。
- 下界只在 `package.json` 写一次：构建脚本强制它必须是 `>=` 形式的开放下界（防止有人改回精确值或加上限），并注入产物。
- 同伴依赖在 profile 中**不被校验**（`autoInstallPeers: false` + `link:`），所以插件自带运行时护栏；本工作区也设了 `autoInstallPeers: false`，开发期不装同伴，类型来自各包内的最小声明。
- 注意：把下界写成稳定版本（如 `>=0.1.0`）会因 semver 预发布规则**装不上** `0.1.6-alpha.1`（pnpm 默认 `autoInstallPeers: true` 时会直接 `ERR_PNPM_NO_MATCHING_VERSION`）。

## 发布

```powershell
cd plugins/session-persona-manager
pnpm run build
npm publish --access public          # 包名已加 @dsh-plugins-xz scope（@dsh-plugins-xz/session-persona-manager），可直接发布
```

注意：`@dsh-plugins-xz/time-utils` / `@dsh-plugins-xz/result-utils` 不单独发布，构建时由 esbuild 内联进 `lib/`，故在 `package.json` 中它们只以 `devDependencies`（`workspace:*`）出现、仅供本地 monorepo 构建期链接；最终 `@dsh-plugins-xz/session-persona-manager` 是单包自包含，用户装一个即可。`pnpm run build` 即可正常构建；打包时由 `prepack` 钩子（`packages/plugin-kit/prepack.mjs`）把 `devDependencies`/`scripts` 从发布包 manifest 中剥离，避免消费方 `pnpm add` 误装构建依赖而跨盘软链失败（Windows 上表现为 `EPERM`）。

装到用户侧：`dsh plugin --profile web add @dsh-plugins-xz/session-persona-manager`。
`peerDependencies` 里的 `@deepseek-ai/cordis` 等由 profile 解析到宿主实例，**不要**把 cordis 打进产物。

## License

本项目以 [MIT 协议](./LICENSE) 发布。各发布包的 `package.json` 均声明 `"license": "MIT"`，使用即表示同意该协议条款。
