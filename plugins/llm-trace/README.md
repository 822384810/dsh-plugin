# llm-trace

把**每次真正发给大模型的请求**落盘成一个可读 JSON：`system`（装配好的系统提示词）、`messages`（完整消息列表）、`tools`（工具 schema）、provider / model / sessionId 等。

用来回答"我的提示词 / 人格 / 工具说明到底有没有进请求"这类问题——不需要调试器，也不需要看模型回复猜。

**核心特性：**
- **完整请求快照**：每次模型请求落盘为 pretty JSON，provider / model / sessionId / system / messages / tools 等字段原样保存。
- **不改请求、不吞响应**：挂在 `llm/stream` waterfall 上，观察后 `next()` 放行；自身出错只打 stderr，绝不影响模型调用。
- **双载体报告系统提示词**：分别统计 `system` 字段与 `messages` 里 `system` 角色消息的字符数，避免被"提示词到底进没进"误导。
- **零配置可用、可降级**：stderr 详细度与文件写入都可关；纯 Host 半区（无浏览器组件）。

## 工作原理

`llm-trace` 复用了 DSH 的以下能力接缝：

| DSH 能力 | 插件用法 |
|---|---|
| `llm/stream` 事件 | 挂在模型请求 waterfall 上观察，调用 `next()` 放行 |
| 文件系统 | 每个请求写 `$DSH_HOME/logs/llm-trace/<序号>-<时间>-<sessionId>.json` |
| `process.stderr` | 每个请求打印一行摘要（`full` 模式下打印整份请求） |

数据流：agent 发起模型请求 → `llm/stream` 事件触发 → 插件快照（丢弃非 JSON 的 `signal`，加 `time`）→ 写 JSON 文件 + stderr 摘要 → `next()` 放行给 provider。

## 安装

```powershell
dsh plugin --profile <profile> add @dsh-plugins-xz/llm-trace
```

调试完移除：从该 profile 的 `package.json` 删掉依赖与 `dsh.profile.bundles` 项，或把 `cordis.patch.yml` 里的 `print` 设为 `off` 并清空日志目录。

临时只用 `--patch` 覆盖层指向 `lib/index.js`（仅 Host 半区，本插件无 Client 半区）：

```yaml
- insert:
    - id: llm-trace
      name: file:///D:/…/dsh-plugin/plugins/llm-trace/lib/index.js
```

## 输出位置

```
$DSH_HOME/logs/llm-trace/<序号>-<时间>-<sessionId>.json
```

- 每个文件是一次请求的完整快照（pretty JSON）。字段与 `llm/stream` 事件收到的请求一致——`signal` 等非 JSON 内部字段被丢弃，并额外写入一个 `time`（ISO-8601 UTC）字段；其余字段（provider / model / sessionId / system / messages / tools …）原样保存。序号按调度顺序递增（`001`、`002`…），便于按时间核对。
- 文件名中的 `<时间>` 是 ISO 时间戳，冒号与小数点被替换为 `-`；`<sessionId>` 缺失时记作 `no-session`。
- stderr 摘要行（`print: summary`，默认）：

```
llm-trace: <provider>/<model> session=<id> messages=<n> systemField=<absent|字符数> systemMessage=<字符数> tools=<n> -> <文件路径>
```

`systemField` 是 `request.system` 字段的字符数（`absent` 表示没有），`systemMessage` 是 `messages` 里 `role=system` 的消息字符数之和——两者分别覆盖"工具调用形态"和"正常对话形态"两种系统提示词载体。

## 配置（cordis.patch.yml）

| 字段 | 默认 | 含义 |
|---|---|---|
| `print` | `summary` | stderr 详细度：`summary` 一行摘要 / `full` 整份请求 / `off` 只写文件 |
| `file` | `true` | 是否写 JSON 文件 |

> 随包附带的 `cordis.patch.yml` 默认把 `print` 设成了 `full`（排查时最直观）；长期使用建议改回 `summary` 或 `off` 以减少噪音。

## 目录

```
src/index.ts         Host 半区：llm/stream 观察者 + 落盘 + stderr 摘要
src/types.ts         自包含的最小 DSH 类型面（LlmRequest / PluginContext，不 import harness 私有包）
src/shims.d.ts       运行时依赖的 harness 包的类型垫片
cordis.patch.yml     bundle 层 + print/file 配置（package.json 的 dsh.bundle.patch 指向它）
```

## 构建与安装

```powershell
cd <dsh-plugin>
pnpm install
pnpm --filter llm-trace run build

# 装进隔离 profile（在 harness checkout 里执行）
cd ..\deepseek-harness
pnpm dsh --profile llm-trace-dev --from-default-profile web --dump-config
pnpm dsh plugin --profile llm-trace-dev add <dsh-plugin>/dsh-plugins-xz-llm-trace-0.1.5.tgz
pnpm dsh --profile llm-trace-dev
```

改 Host 半区后需要重启 `dsh --profile llm-trace-dev`。

## 怎么读

系统提示词**不在** `options.system` 上（那是会话命名等工具调用的形态），而是在 `messages` 里 role 为 `system` 的那条消息。摘要行同时给出两个载体：`systemField=absent systemMessage=4288`。

```powershell
# 找最新一次请求，看系统提示词里有没有你的标记
$dir = "$env:USERPROFILE\.dsh\logs\llm-trace"
$latest = Get-ChildItem $dir -Filter *.json | Sort-Object LastWriteTime | Select-Object -Last 1
$req = Get-Content $latest.FullName -Raw -Encoding utf8 | ConvertFrom-Json
$req.messages | Where-Object { $_.role -eq 'system' } | ForEach-Object { $_.content.text }
$req.messages | Select-Object role, @{ n='chars'; e={ ($_.content | ForEach-Object { $_.text }) -join '' | Measure-Object -Character | Select-Object -ExpandProperty Characters } }
```

## 示例：验证人格是否进了请求

| 请求 | messages | system 字数 | 人格 |
|---|---|---|---|
| 新会话首次请求（未绑人格） | 5 | 4278 | 无 |
| 同轮内用工具绑定人格后的下一次请求 | 7 | 4288 | **有**（`@112`，8 字人格 + 分隔换行） |
| 续跑已绑人格的会话 | 13 | 4288 | **有** |
| 会话命名等工具调用 | 1 | 0（`systemField=363`） | 无 |

## 注意

- 落盘内容包含完整提示词与会话文本，按敏感数据对待；排查完请清理 `$DSH_HOME/logs/llm-trace/`。
