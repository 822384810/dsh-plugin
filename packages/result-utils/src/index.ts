/**
 * Unified API envelope shared by every DSH plugin.
 *
 * Every `/api` route returns `{ code, msg, data }`; the numeric {@link ResultCode}
 * (not the HTTP status) is the source of truth for the business outcome. The Host
 * half builds it with {@link reply}; the browser half decodes it with {@link unwrap}.
 * Keeping the shape in one package means every plugin speaks the same wire format.
 */

/** Business outcome codes, mirrored from the host's `ResultCode` convention. */
export enum ResultCode {
  OK = 0,
  FAIL = 1,
  PARAM_ERR = 2,
  NO_LOGIN = 3,
  NO_AUTH = 4,
  EXCEPTION = -1,
}

/** The envelope every route returns. */
export interface Result<T> {
  code: ResultCode
  msg: string
  data: T | null
}

/**
 * Build a `Response` carrying the unified envelope.
 * @param code - Business outcome from {@link ResultCode}.
 * @param msg - Human-readable message; `"ok"` on success.
 * @param data - Payload on success, or `null` on failure/empty.
 * @returns A 200 `Response` with `cache-control: no-store`.
 */
export function reply<T>(code: ResultCode, msg: string, data: T | null = null): Response {
  return Response.json({ code, msg, data } satisfies Result<T>, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Decode the unified `{ code, msg, data }` envelope.
 * @throws When the HTTP status is not 2xx, or the business `code` is non-zero.
 */
export async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`)
  const envelope = await response.json() as Result<T>
  if (envelope.code !== ResultCode.OK) throw new Error(envelope.msg || 'request failed')
  return envelope.data as T
}
