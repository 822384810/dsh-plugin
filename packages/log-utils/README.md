# @dsh-plugins-xz/log-utils

所有 DSH 插件共用的日志工具，保证每个插件的日志前缀、级别与落点一致。

每行格式为 `ts [LEVEL] [label] message`（Cordis 风格，与 dsh 宿主对齐）：

- `ts` 为 ISO-8601 本地时间戳（`time-utils` 的 `localTimestamp()`），默认带；传 `timestamp: false` 则只留 `[LEVEL] [label] message`。
- `[LEVEL]` 始终是 `D` / `I` / `W` / `E` 之一，无法关闭。
- `[label]` 即 `createLogger` 的第一个参数（插件名）。

## API

| 符号 | 说明 |
|:--|:--|
| `type LogLevel` | 级别：`'debug' \| 'info' \| 'warn' \| 'error'`（与 harness logger 一致）。 |
| `interface Logger` | 插件对外暴露的窄接口：`debug` / `info` / `warn` / `error`，均不抛错。 |
| `interface LoggerSink` | harness logger 的最小切片，每个级别都可选（`debug?` / `info?` / `warn?` / `error?`）。 |
| `interface LoggerOptions` | `{ sink?, console?, file?, timestamp? }`，详见下方。 |
| `createLogger(label, options?): Logger` | 构造 logger，写到终端 + 文件 +（可选）harness sink 三处；任何一路失败都不影响业务。 |
| `dshLogFile(name): string \| undefined` | 默认日志文件路径 `$DSH_HOME/logs/<name>.log`（未设 `DSH_HOME` 时退到 `~/.dsh/logs/<name>.log`）；无文件系统时（浏览器）返回 `undefined`。 |

`LoggerOptions`：

- `sink?` —— 传 harness logger（`ctx.logger`）时，把**原始 message**转发给它（覆盖所有级别）；harness 会自己加 `ts [L] name` 前缀，所以这里不转发已格式化好的整行，避免宿主流里前缀重复。
- `console?` —— 是否写终端，默认 `true`。宿主写 `stderr`（不污染可能承载协议的 stdout），浏览器退化为对应的 `console` 方法；`false` 可关。
- `file?` —— 日志文件路径，默认 `$DSH_HOME/logs/<label>.log`；传 `false` 关闭文件写入。
- `timestamp?` —— 每行是否加 ISO 时间戳前缀，默认 `true`；`false` 则只留 `[LEVEL] [label] message`。

## 用法

```ts
import { createLogger, type Logger } from '@dsh-plugins-xz/log-utils'

// 终端 + $DSH_HOME/logs/llm-wiki.log，并转发给 harness logger
const log: Logger = createLogger('llm-wiki', { sink: ctx.logger })

// 只进终端，不写文件
const quiet = createLogger('llm-wiki', { file: false })

// 指定日志文件，并关掉时间戳前缀
const custom = createLogger('llm-wiki', { sink: ctx.logger, file: '/var/log/llm-wiki.log', timestamp: false })

log.debug('cache hit')
log.warn('embedding model missing')
```

## 为什么要自己写终端与文件

harness logger（`ctx.logger`）的内置 exporter **只把消息放进内存环形缓冲**，默认既不打控制台、也不写文件；本工作区内部测试也证实：插件日志只转发给 `ctx.logger` 时，终端上看不到。因此本包**自己**保证「终端 + 文件」两个落点，并额外把消息转发给 sink 供宿主审计。

浏览器半区没有文件系统：文件写入会被自动跳过（`dshLogFile()` 返回 `undefined`），终端落点退化为 `console`。
