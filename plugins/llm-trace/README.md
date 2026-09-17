# llm-trace

把**每次真正发给大模型的请求**落盘成一个可读 JSON：`system`（装配好的系统提示词）、`messages`（完整消息列表）、`tools`（工具 schema）、provider/model/sessionId 等。

用来回答"我的提示词/人格/工具说明到底有没有进请求"这类问题——不需要调试器，也不需要看模型回复猜。

## 输出位置

```
$DSH_HOME/logs/llm-trace/<序号>-<时间>-<sessionId>.json
```

每个文件是一次请求的完整快照（pretty JSON），字段与 `llm/stream` 事件收到的请求一致（`signal` 等非 JSON 内部字段被丢弃）。序号按调度顺序递增，便于按时间核对。

stderr 上每个请求一行摘要：

```
llm-trace: agnes/agnes-3.0-flash session=session-98a3c907-… messages=13 systemField=absent systemMessage=4288 tools=25 -> C:\Users\admin\.dsh\logs\llm-trace\001-….json
```

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `print` | `summary` | stderr 详细度：`summary` 一行摘要 / `full` 整份请求 / `off` 只写文件 |
| `file` | `true` | 是否写 JSON 文件 |

## 安装 / 卸载

```powershell
# 装进某个 profile（在 harness checkout 里执行）
pnpm dsh plugin --profile <profile> add <dsh-plugin>/dsh-plugins-xz-llm-trace-0.1.5.tgz

# 调试完移除：从该 profile 的 package.json 里删掉依赖与 dsh.profile.bundles 项，或
# 把 cordis.patch.yml 里的 print 设为 off 并清空日志目录
```

临时调试也可以只用 `--patch` 覆盖层指向 `lib/index.js`（仅 Host 半区，llm-trace 也没有 Client 半区）：

```yaml
- insert:
    - id: llm-trace
      name: file:///D:/…/dsh-plugin/plugins/llm-trace/lib/index.js
```

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

## 实测例子（本仓库 persona 插件）

| 请求 | messages | system 字数 | 人格 |
|---|---|---|---|
| 新会话首次请求（未绑人格） | 5 | 4278 | 无 |
| 同轮内用工具绑定人格后的下一次请求 | 7 | 4288 | **有**（`@112`，8 字人格 + 分隔换行） |
| 续跑已绑人格的会话 | 13 | 4288 | **有** |
| 会话命名等工具调用 | 1 | 0（`systemField=363`） | 无 |

## 注意

- 落盘内容包含完整提示词与会话文本，按敏感数据对待；排查完请清理 `$DSH_HOME/logs/llm-trace/`。
- 它挂在 `llm/stream` waterfall 上、只观察后 `next()` 放行，既不改请求也不会吞掉响应；自身出错只打 stderr，不影响模型调用。
