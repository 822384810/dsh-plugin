/**
 * Text decoding for sources that predate UTF-8.
 *
 * Chinese standard documents are still routinely published as GBK / GB18030 / Big5 files;
 * reading those as UTF-8 silently corrupts the whole library. The common case (UTF-8, with or
 * without a BOM) needs no dependency at all — `iconv-lite` and `jschardet-ultra` are only
 * loaded once a buffer actually fails strict UTF-8 decoding.
 */
import { importOptional } from './optional.ts'

/**
 * Decode a buffer to text, detecting the encoding when it is not UTF-8.
 * @param buffer - Raw file bytes.
 * @returns The decoded text.
 */
export async function decodeBuffer(buffer: Buffer): Promise<string> {
  const bom = decodeWithBom(buffer)
  if (bom !== undefined) return bom
  const strict = strictUtf8(buffer)
  if (strict !== undefined) return strict
  const detected = await detectEncoding(buffer)
  if (detected !== undefined) return detected
  return buffer.toString('utf8')
}

/** Read a BOM when one is present; undefined when the buffer has none. */
function decodeWithBom(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swapUtf16le(buffer.subarray(2))
  }
  return undefined
}

/** Decode strictly, or report failure instead of substituting replacement characters. */
function strictUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return undefined
  }
}

/** Ask `jschardet-ultra` and decode with `iconv-lite`; both are optional installs. */
async function detectEncoding(buffer: Buffer): Promise<string | undefined> {
  try {
    const [iconv, jschardet] = await Promise.all([
      importOptional<typeof import('iconv-lite')>('iconv-lite'),
      importOptional<typeof import('jschardet-ultra')>('jschardet-ultra'),
    ])
    if (iconv === null || jschardet === null) return undefined
    const guess = jschardet.detect(buffer)
    if (guess.encoding === null || guess.confidence <= 0.8) return undefined
    return iconv.decode(buffer, guess.encoding)
  } catch {
    return undefined
  }
}

/** Convert a big-endian UTF-16 payload, which `Buffer` cannot decode directly. */
function swapUtf16le(buffer: Buffer): string {
  const swapped = Buffer.from(buffer)
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const high = swapped[i]
    swapped[i] = swapped[i + 1] as number
    swapped[i + 1] = high as number
  }
  return swapped.toString('utf16le')
}
