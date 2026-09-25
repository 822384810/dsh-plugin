# @dsh-plugins-xz/result-utils

所有 DSH 插件共用的统一 HTTP 返回体，保证每个插件的接口线格式一致。

每个 `/api` 路由都返回 `{ code, msg, data }`；业务结果以数字 `code`（而非 HTTP 状态）为准。Host 半区用 `reply` 构造，浏览器半区用 `unwrap` 解析。集中在同一包，是为了让所有插件说同一种线格式。

## API

| 符号 | 说明 |
|:--|:--|
| `enum ResultCode` | 业务结果码：`OK=0` / `FAIL=1` / `PARAM_ERR=2` / `NO_LOGIN=3` / `NO_AUTH=4` / `EXCEPTION=-1`。 |
| `type Result<T>` | 信封 `{ code: ResultCode, msg: string, data: T \| null }`。 |
| `reply(code, msg, data?): Response` | Host 半区构造返回：`{ code, msg, data }`，HTTP 状态恒 200，`cache-control: no-store`，`data` 缺省为 `null`。 |
| `unwrap<T>(response): Promise<T>` | 浏览器半区解析：`response` 非 2xx 或 `code !== 0` 时抛错（消息取 `msg`），否则返回 `data`。 |

## 用法

```ts
// Host 半区
import { ResultCode, reply } from '@dsh-plugins-xz/result-utils'

return reply(ResultCode.OK, 'ok', payload)
return reply(ResultCode.PARAM_ERR, 'sessionId is required')

// 浏览器半区
import { unwrap } from '@dsh-plugins-xz/result-utils'

const data = await unwrap<PersonaView[]>(await fetch('/api/...'))
```

HTTP 状态恒为 200，业务结果一律以 `code` 区分；鉴权类 `NO_LOGIN` / `NO_AUTH` 通常由连接层栅栏在路由之前拦截，路由内一般无需处理。
