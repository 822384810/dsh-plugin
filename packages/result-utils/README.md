# @dsh-plugins-xz/result-utils

所有 DSH 插件共用的统一 HTTP 返回体，保证每个插件的接口线格式一致。

- `ResultCode` —— 业务结果码枚举：`OK=0` / `FAIL=1` / `PARAM_ERR=2` / `NO_LOGIN=3` / `NO_AUTH=4` / `EXCEPTION=-1`。
- `Result<T>` —— 信封类型：`{ code: ResultCode, msg: string, data: T | null }`。
- `reply(code, msg, data?)` —— Host 半区构造 `Response`：`{ code, msg, data }`，HTTP 状态恒 200，`cache-control: no-store`。
- `unwrap<T>(response)` —— 浏览器半区解析：非 2xx 或 `code !== 0` 时抛错，否则返回 `data`。

用法：

```ts
// Host 半区
import { ResultCode, reply } from '@dsh-plugins-xz/result-utils'

return reply(ResultCode.OK, 'ok', payload)
return reply(ResultCode.PARAM_ERR, 'sessionId is required')

// 浏览器半区
import type { Result } from '@dsh-plugins-xz/result-utils'
import { ResultCode, unwrap } from '@dsh-plugins-xz/result-utils'

const data = await unwrap<PersonaView[]>(await fetch('/api/...'))
```

HTTP 状态恒为 200，业务结果一律以 `code` 区分；鉴权类 `NO_LOGIN` / `NO_AUTH` 通常由连接层栅栏在路由之前拦截。
