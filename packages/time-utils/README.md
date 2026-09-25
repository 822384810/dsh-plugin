# @dsh-plugins-xz/time-utils

所有 DSH 插件统一使用的时间工具，作为唯一的时间真源（single source of truth）。

插件需要时间时一律走本包，不要直接调 `Date.now()` / `new Date()` / `toISOString()`；这样时间格式一致，将来要替换实现（如测试时注入固定时钟）只需改这一处。

## API

| 符号 | 说明 |
|:--|:--|
| `now(): Timestamp` | 当前时间（epoch 毫秒）。取原始时间戳时调它。 |
| `formatTimestamp(ts?: Timestamp): string` | 格式化为 **ISO-8601 UTC** 字符串（如 `2026-09-17T08:30:00.000Z`）。用于**机器记录**：需跨机器、跨时区可比较的时间。 |
| `localDate(ts?: Timestamp): string` | 格式化为**本机时区**的 `YYYY-MM-DD`。 |
| `localTimestamp(ts?: Timestamp): string` | 格式化为**本机时区**的 `YYYY-MM-DD HH:mm:ss`。 |
| `type Timestamp = number` | 时间戳类型，插件落盘时用 epoch 毫秒表示。 |

所有格式化函数都接受可选的 `ts` 参数（默认 `now()`），既能格式化“此刻”，也能格式化任意历史时间戳。

## 该用哪个

| 场景 | 用 |
|:--|:--|
| 落盘的机器记录、需跨时区比较（如日志排序字段、人格 `createTime`） | `formatTimestamp()` |
| **给人看的日期/时间**（页面 `updated`、变更记录、界面文案） | `localDate()` / `localTimestamp()` |

之所以要分开：UTC 与读者的本地日历在午夜前后会差一天。例如 UTC+8 的凌晨写入，`formatTimestamp()` 给出的日期是**前一天**，直接展示会让人误判。

## 示例

```ts
import { formatTimestamp, localDate, localTimestamp } from '@dsh-plugins-xz/time-utils'

const createdAt = formatTimestamp()   // "2026-09-17T08:30:00.000Z"（UTC，机器记录）
const updatedAt = localDate()         // "2026-09-17"           （本地，给人看）
const loggedAt = localTimestamp()     // "2026-09-17 16:30:00"  （本地，给人看，UTC+8）
```
