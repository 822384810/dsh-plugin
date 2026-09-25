/**
 * PP-OCR text recognition — a drop-in replacement for Tesseract on scanned PDFs.
 *
 * Tesseract's `chi_sim` model is the weak link in the ingest pipeline: it misreads Chinese set in
 * varied fonts, shoves a space between every ideograph, and collapses table cells into nonsense.
 * PP-OCR (the PaddleOCR detection + recognition models) is dramatically better for Chinese and
 * mixed CJK/Latin pages, and its ONNX export runs on the CPU through `onnxruntime-node` — the same
 * runtime the embedder already loads — so this adds no new dependency and no external program.
 *
 * The models ship inside the package (`models/ppocr/`, fetched at pack time from the official
 * PaddlePaddle HuggingFace repos) and a deployment can point `ocrModelDir` elsewhere instead.
 * Without any of them `load()` returns `null` and the caller falls back to Tesseract, so nothing
 * here can take the plugin down. The detection post-process uses axis-aligned connected
 * components rather than the full DB polygon/unclip: it is simpler and enough for the
 * near-horizontal pages a standard prints, at the cost of tight boxes around slanted text.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { importOptional } from '../shared/optional.ts'

/** A recognized text region: its line and the box it occupied, in full-page image pixels. */
export interface TextRect {
  readonly text: string
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** Tunable pipeline parameters; the defaults match PP-OCRv4/v5/v6 mobile and small models. */
export interface PpOptions {
  /** Longest detection input side, resized to a multiple of 32. */
  readonly detLimitSide: number
  /** Binarization threshold on the detection probability map. */
  readonly detThreshold: number
  /** Mean box score below which a component is discarded as noise. */
  readonly detBoxThreshold: number
  /** Box expansion as a fraction of its short side, approximating DB's unclip. */
  readonly detUnclipRatio: number
  /** Recognition input height; width follows the aspect ratio. */
  readonly recHeight: number
}

/** RGBA pixels of one rasterized page. */
interface RgbImage {
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** The slice of `onnxruntime-node` this file uses; typed structurally like the embedder's. */
interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown
  InferenceSession: {
    create(buffer: Uint8Array, options: Record<string, unknown>): Promise<OrtSession>
  }
}

interface OrtSession {
  readonly inputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtValue>>
}

interface OrtValue {
  readonly dims: readonly number[]
  readonly data: Float32Array | BigInt64Array
}

/** Default pipeline settings. */
const DEFAULTS: PpOptions = {
  detLimitSide: 960,
  detThreshold: 0.3,
  detBoxThreshold: 0.5,
  detUnclipRatio: 1.5,
  recHeight: 48,
}

/** Widest input the exported recognition graph accepts — its dynamic shape window tops out at
 * `[N, 3, 48, 3200]` — so a line whose height-48 natural width fits is read in a single pass. */
const MAX_REC_WIDTH = 3200
/** Narrowest input the graph accepts: the exported minimum is `[1, 3, 48, 160]`, and a narrower
 * tensor crashes ONNX Runtime's native code (an access violation, not a catchable error). */
const MIN_REC_WIDTH = 160

/**
 * Recognize a scanned page with PP-OCR.
 *
 * One instance holds the loaded ONNX sessions and the recognition dictionary; {@link recognize}
 * runs detection, optional orientation classification, and recognition over a rasterized page and
 * returns the text boxes in top-to-bottom, left-to-right reading order.
 */
export class PpOcrEngine {
  private det: OrtSession | null = null
  private rec: OrtSession | null = null
  private cls: OrtSession | null = null
  private chars: readonly string[] = []
  private ort: OrtModule | null = null

  /** @param modelDir - Directory holding `det.onnx`, `rec.onnx`, `rec.dict.txt` (and optional `cls.onnx`). */
  constructor(private readonly modelDir: string, private readonly opts: PpOptions = DEFAULTS) {}

  /**
   * Load the sessions and dictionary.
   * @returns false when the model files or `onnxruntime-node` are unavailable.
   */
  async load(): Promise<boolean> {
    const ort = await importOptional<OrtModule>('onnxruntime-node')
    if (ort === null) return false
    try {
      const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
      this.det = await ort.InferenceSession.create(
        await readFile(path.join(this.modelDir, 'det.onnx')), options,
      )
      this.rec = await ort.InferenceSession.create(
        await readFile(path.join(this.modelDir, 'rec.onnx')), options,
      )
      // The exported dict (PP-OCRv4/v5 `ppocrv*_dict.txt`, v6 `ppocrv6_dict.txt`, or the tiny
      // tier's separate `ppocrv6_tiny_dict.txt`) lists one character per line with no blank;
      // index 0 of the model's CTC classes is the blank in every generation, so a placeholder
      // is prepended unless the file already starts with a blank line. The dict must match the
      // rec tier — v6 tiny has its own smaller charset and mis-pairs shift every index.
      const dict = (await readFile(path.join(this.modelDir, 'rec.dict.txt'), 'utf8')).split(/\r?\n/)
      if (dict[0] !== undefined && dict[0].trim() !== '') dict.unshift('　')
      this.chars = dict
      this.ort = ort
      try {
        this.cls = await ort.InferenceSession.create(
          await readFile(path.join(this.modelDir, 'cls.onnx')), options,
        )
      } catch {
        this.cls = null
      }
      return true
    } catch {
      this.det = null
      this.rec = null
      this.cls = null
      return false
    }
  }

  /**
   * Read one rasterized page.
   * @param rgba - The page pixels (RGBA) as taken from the canvas.
   * @param width - Page image width.
   * @param height - Page image height.
   * @returns Detected text boxes, each a fragment, sorted top-to-bottom then left-to-right. The
   * boxes are kept per-fragment (not merged into lines) so the caller's table geometry can place
   * each one into its cell.
   */
  async recognize(rgba: Uint8ClampedArray, width: number, height: number): Promise<TextRect[]> {
    const det = this.det
    const rec = this.rec
    const ort = this.ort
    if (det === null || rec === null || ort === null) return []
    const image: RgbImage = { rgba, width, height }
    const boxes = await this.detect(ort, det, image)
    const rects: TextRect[] = []
    for (const box of boxes) {
      let crop = cropBox(image, box)
      if (this.cls !== null && await this.isFlipped(ort, this.cls, crop)) {
        crop = rotate180(crop)
      }
      const text = await this.recognizeLine(ort, rec, crop)
      if (text.trim() !== '') rects.push({ text, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 })
    }
    return rects.sort((left, right) =>
      (left.y0 + left.y1) / 2 - (right.y0 + right.y1) / 2 || left.x0 - right.x0)
  }

  /** Run text detection and return expanded, axis-aligned text boxes. */
  private async detect(ort: OrtModule, session: OrtSession, image: RgbImage): Promise<Omit<TextRect, 'text'>[]> {
    const { width: ow, height: oh, scaleX, scaleY } = detInputSize(image.width, image.height, this.opts.detLimitSide)
    const chw = preprocessDet(image, ow, oh)
    const feeds: Record<string, unknown> = { [session.inputNames[0] as string]: new ort.Tensor('float32', chw, [1, 3, oh, ow]) }
    const output = firstOutput(await session.run(feeds))
    const dims = output.dims
    const mapH = dims[dims.length - 2] ?? oh
    const mapW = dims[dims.length - 1] ?? ow
    const prob = output.data as Float32Array
    const mask = new Uint8Array(mapH * mapW)
    for (let i = 0; i < mask.length; i++) mask[i] = (prob[i] ?? 0) > this.opts.detThreshold ? 1 : 0
    const components = connectedComponents(mask, prob, mapW, mapH, this.opts.detBoxThreshold)
    const boxes: Omit<TextRect, 'text'>[] = []
    for (const component of components) {
      const bx0 = component.x0 / scaleX
      const by0 = component.y0 / scaleY
      const bw = (component.x1 - component.x0) / scaleX
      const bh = (component.y1 - component.y0) / scaleY
      if (bw < 3 || bh < 3) continue
      const pad = Math.min(bw, bh) * (this.opts.detUnclipRatio - 1) / 2
      boxes.push({
        x0: Math.max(0, Math.round(bx0 - pad)),
        y0: Math.max(0, Math.round(by0 - pad)),
        x1: Math.min(image.width, Math.round(bx0 + bw + pad)),
        y1: Math.min(image.height, Math.round(by0 + bh + pad)),
      })
    }
    return boxes
  }

  /** Whether a line crop is rotated 180°, using the optional orientation classifier. */
  private async isFlipped(ort: OrtModule, session: OrtSession, image: RgbImage): Promise<boolean> {
    const height = 48
    const width = Math.max(8, Math.min(192, Math.round(image.width / image.height * height)))
    const input = preprocessCls(image, width, height)
    const feeds: Record<string, unknown> = { [session.inputNames[0] as string]: new ort.Tensor('float32', input, [1, 3, height, width]) }
    const output = firstOutput(await session.run(feeds))
    const scores = output.data as Float32Array
    // cls emits [prob_0, prob_180]; PaddleOCR flips only when the 180° class clears its 0.9
    // threshold — testing `prob_0 < 0.9` instead would flip uncertain-but-upright lines.
    return (scores[1] ?? 0) >= 0.9
  }

  /** Recognize one line crop, splitting over-wide crops into columns the recognizer can read. */
  private async recognizeLine(ort: OrtModule, session: OrtSession, image: RgbImage): Promise<string> {
    if (image.width === 0 || image.height === 0) return ''
    const height = this.opts.recHeight
    const natural = Math.round(image.width / image.height * height)
    // Read a line whole whenever it fits the recognition graph's dynamic width window. Feeding the
    // entire line — rather than slicing it into pixel columns — is what keeps ideographs from being
    // cut in half: a hard split duplicated the straddling glyph in both neighbours (农农、茶茶) and
    // left the recognizer with half a character, which no model tier can read. Only a line longer
    // than the graph accepts at all is split, and then into pieces whose own natural width still
    // fits `MAX_REC_WIDTH`, so every recursion is strictly narrower than its parent and terminates.
    if (natural <= MAX_REC_WIDTH) {
      const width = Math.max(MIN_REC_WIDTH, natural)
      const input = preprocessRec(image, width, height)
      const feeds: Record<string, unknown> = { [session.inputNames[0] as string]: new ort.Tensor('float32', input, [1, 3, height, width]) }
      const output = firstOutput(await session.run(feeds))
      return ctcDecode(output, this.chars)
    }
    const pieces = Math.ceil(natural / MAX_REC_WIDTH)
    const sliceWidth = Math.ceil(image.width / pieces)
    let text = ''
    for (let offset = 0; offset < image.width; offset += sliceWidth) {
      const piece = sliceColumns(image, offset, Math.min(sliceWidth, image.width - offset))
      text += await this.recognizeLine(ort, session, piece)
    }
    return text
  }
}

/** Pick the model's first (usually only) output tensor. */
function firstOutput(outputs: Record<string, OrtValue>): OrtValue {
  const values = Object.values(outputs)
  const value = values[0]
  if (value === undefined) throw new Error('model produced no output')
  return value
}

/** Choose the detection input size and the per-axis map-to-page scale (rounded to a multiple of 32). */
function detInputSize(
  width: number,
  height: number,
  limit: number,
): { width: number; height: number; scaleX: number; scaleY: number } {
  const ratio = Math.min(limit / width, limit / height, 1)
  const ow = Math.max(32, Math.round(width * ratio / 32) * 32)
  const oh = Math.max(32, Math.round(height * ratio / 32) * 32)
  return { width: ow, height: oh, scaleX: ow / width, scaleY: oh / height }
}

/**
 * Resize (bilinear) an RGBA page to a BGR CHW float array.
 *
 * The detector was trained with ImageNet normalization — `(x / 255 - mean) / std` with
 * mean [0.485, 0.456, 0.406], std [0.229, 0.224, 0.225] applied over the B, G, R planes in that
 * order (PaddleOCR's OpenCV convention) — not the plain 0.5/0.5 scaling the recognizer uses.
 * Feeding bare [0, 1] pixels to a PP-OCRv4/v5/v6 det model shifts its input distribution far
 * enough off-distribution to seriously degrade detection.
 */
function preprocessDet(image: RgbImage, outWidth: number, outHeight: number): Float32Array {
  const mean = [0.485, 0.456, 0.406] // B, G, R
  const std = [0.229, 0.224, 0.225]
  const out = new Float32Array(3 * outHeight * outWidth)
  const plane = outHeight * outWidth
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * image.height / outHeight - 0.5))
    const y0 = Math.floor(sy)
    const fy = sy - y0
    const y1 = Math.min(image.height - 1, y0 + 1)
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * image.width / outWidth - 0.5))
      const x0 = Math.floor(sx)
      const fx = sx - x0
      const x1 = Math.min(image.width - 1, x0 + 1)
      const index = y * outWidth + x
      out[index] = (lerp2(image, x0, y0, x1, y1, fx, fy, 2) / 255 - (mean[0] as number)) / (std[0] as number)
      out[plane + index] = (lerp2(image, x0, y0, x1, y1, fx, fy, 1) / 255 - (mean[1] as number)) / (std[1] as number)
      out[2 * plane + index] = (lerp2(image, x0, y0, x1, y1, fx, fy, 0) / 255 - (mean[2] as number)) / (std[2] as number)
    }
  }
  return out
}

/** Resize an RGBA crop to `outWidth x outHeight` and normalize with PP-OCR's rec mean/std. */
function preprocessRec(image: RgbImage, outWidth: number, outHeight: number): Float32Array {
  const mean = [0.5, 0.5, 0.5]
  const std = [0.5, 0.5, 0.5]
  const out = new Float32Array(3 * outHeight * outWidth)
  const plane = outHeight * outWidth
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * image.height / outHeight - 0.5))
    const y0 = Math.floor(sy)
    const fy = sy - y0
    const y1 = Math.min(image.height - 1, y0 + 1)
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * image.width / outWidth - 0.5))
      const x0 = Math.floor(sx)
      const fx = sx - x0
      const x1 = Math.min(image.width - 1, x0 + 1)
      const index = y * outWidth + x
      // Channel order is BGR (OpenCV convention the models were trained on): pixel[2]=B, [1]=G, [0]=R.
      const b = lerp2(image, x0, y0, x1, y1, fx, fy, 2)
      const g = lerp2(image, x0, y0, x1, y1, fx, fy, 1)
      const r = lerp2(image, x0, y0, x1, y1, fx, fy, 0)
      out[index] = (b / 255 - mean[2] as number) / std[2] as number
      out[plane + index] = (g / 255 - mean[1] as number) / std[1] as number
      out[2 * plane + index] = (r / 255 - mean[0] as number) / std[0] as number
    }
  }
  return out
}

/** Resize an RGBA crop and normalize with PP-OCR's classification mean/std (BGR). */
function preprocessCls(image: RgbImage, outWidth: number, outHeight: number): Float32Array {
  const mean = [0.5, 0.5, 0.5]
  const std = [0.5, 0.5, 0.5]
  const out = new Float32Array(3 * outHeight * outWidth)
  const plane = outHeight * outWidth
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const src = (Math.min(image.height - 1, y) * image.width + Math.min(image.width - 1, x)) * 4
      const index = y * outWidth + x
      out[index] = (((image.rgba[src + 2] ?? 255) / 255) - (mean[2] as number)) / (std[2] as number)
      out[plane + index] = (((image.rgba[src + 1] ?? 255) / 255) - (mean[1] as number)) / (std[1] as number)
      out[2 * plane + index] = (((image.rgba[src] ?? 255) / 255) - (mean[0] as number)) / (std[0] as number)
    }
  }
  return out
}

/** Bilinear sample of one channel (offset 0=R,1=G,2=B) across the four neighbours. */
function lerp2(image: RgbImage, x0: number, y0: number, x1: number, y1: number, fx: number, fy: number, offset: number): number {
  const stride = image.width * 4
  const top = image.rgba[y0 * stride + x0 * 4 + offset] ?? 255
  const right = image.rgba[y0 * stride + x1 * 4 + offset] ?? 255
  const bottom = image.rgba[y1 * stride + x0 * 4 + offset] ?? 255
  const corner = image.rgba[y1 * stride + x1 * 4 + offset] ?? 255
  const first = top + (right - top) * fx
  const second = bottom + (corner - bottom) * fx
  return first + (second - first) * fy
}

/** Copy a rectangular region of a page into its own RGBA image. */
function cropBox(image: RgbImage, box: Omit<TextRect, 'text'>): RgbImage {
  const width = Math.max(1, box.x1 - box.x0)
  const height = Math.max(1, box.y1 - box.y0)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = ((box.y0 + y) * image.width + box.x0) * 4
    rgba.set(image.rgba.subarray(srcRow, srcRow + width * 4), y * width * 4)
  }
  return { rgba, width, height }
}

/** Take a vertical slice of a crop, for splitting over-wide lines. */
function sliceColumns(image: RgbImage, x0: number, width: number): RgbImage {
  const rgba = new Uint8ClampedArray(width * image.height * 4)
  for (let y = 0; y < image.height; y++) {
    const srcRow = (y * image.width + x0) * 4
    rgba.set(image.rgba.subarray(srcRow, srcRow + width * 4), y * width * 4)
  }
  return { rgba, width, height: image.height }
}

/** Rotate a crop 180°, used when the classifier reports an upside-down line. */
function rotate180(image: RgbImage): RgbImage {
  const rgba = new Uint8ClampedArray(image.rgba.length)
  const stride = image.width * 4
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * stride + x * 4)
      const to = ((image.height - 1 - y) * stride + (image.width - 1 - x) * 4)
      rgba[to] = image.rgba[from] ?? 0
      rgba[to + 1] = image.rgba[from + 1] ?? 0
      rgba[to + 2] = image.rgba[from + 2] ?? 0
      rgba[to + 3] = image.rgba[from + 3] ?? 0
    }
  }
  return { rgba, width: image.width, height: image.height }
}

/** One connected text region on the detection map, with its box (map pixels) and mean score. */
interface Component {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  readonly score: number
}

/**
 * Label foreground regions on the probability map with a flood fill (scanline stack, no recursion).
 * @returns Components whose mean probability clears `boxThreshold`, in raster order.
 */
function connectedComponents(
  mask: Uint8Array,
  prob: Float32Array,
  width: number,
  height: number,
  boxThreshold: number,
): Component[] {
  const seen = new Uint8Array(width * height)
  const components: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if ((mask[start] ?? 0) === 0 || (seen[start] ?? 0) === 1) continue
    let x0 = start % width
    let x1 = x0
    let y0 = Math.floor(start / width)
    let y1 = y0
    let count = 0
    let sum = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const index = stack.pop() as number
      const x = index % width
      const y = (index - x) / width
      count++
      sum += prob[index] ?? 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && (mask[index - 1] ?? 0) === 1 && (seen[index - 1] ?? 0) === 0) { seen[index - 1] = 1; stack.push(index - 1) }
      if (x < width - 1 && (mask[index + 1] ?? 0) === 1 && (seen[index + 1] ?? 0) === 0) { seen[index + 1] = 1; stack.push(index + 1) }
      if (y > 0 && (mask[index - width] ?? 0) === 1 && (seen[index - width] ?? 0) === 0) { seen[index - width] = 1; stack.push(index - width) }
      if (y < height - 1 && (mask[index + width] ?? 0) === 1 && (seen[index + width] ?? 0) === 0) { seen[index + width] = 1; stack.push(index + width) }
    }
    // Mean probability over the region: a box the detector is unsure about is dropped.
    const score = count === 0 ? 0 : sum / count
    if (score < boxThreshold) continue
    components.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, score })
  }
  return components
}

/** Greedy CTC decode: argmax each timestep, drop the blank (index 0) and collapse repeats. */
function ctcDecode(output: OrtValue, chars: readonly string[]): string {
  const dims = output.dims
  const classes = dims[dims.length - 1] ?? 0
  const timeSteps = dims[dims.length - 2] ?? 1
  const data = output.data as Float32Array
  let text = ''
  let previous = -1
  for (let t = 0; t < timeSteps; t++) {
    let best = -1
    let bestScore = -Infinity
    for (let c = 0; c < classes; c++) {
      const score = data[t * classes + c] ?? 0
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best !== -1 && best !== previous && best !== 0) {
      const character = chars[best]
      if (character !== undefined) text += character
    }
    previous = best
  }
  return text
}

