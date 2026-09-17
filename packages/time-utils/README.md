# @dsh-plugins-xz/time-utils

所有 DSH 插件统一使用的时间工具，作为唯一的时间真源（single source of truth）。

- `now(): number` —— 返回当前时间（epoch 毫秒）。所有插件需要原始时间戳时调用它，不要直接 `Date.now()`。
- `formatTimestamp(ts?): string` —— 把时间戳格式化为 ISO-8601 UTC 字符串（如 `2026-09-17T08:30:00.000Z`）。**所有插件落盘的人肉可读时间都用这个方法**，例如人格的 `createTime` / `updateTime`。

统一使用本包的好处：时间戳格式一致；将来要替换实现（如测试时注入固定时钟）只需改这一处。

```ts
import { formatTimestamp } from '@dsh-plugins-xz/time-utils'

const createdAt = formatTimestamp() // 例如 "2026-09-17T08:30:00.000Z"
```
