/**
 * Optional embedding model.
 *
 * A sentence-transformer ONNX model turns chunks into vectors so that retrieval matches on
 * meaning as well as wording. It is genuinely optional: without a model the plugin runs
 * lexical-only, which is weaker but complete. `onnxruntime-node` and the model file are both
 * loaded lazily, so the cost is paid only by deployments that opt in.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { importOptional } from '../shared/optional.ts'

/** The slice of `onnxruntime-node` this file uses. */
interface OrtModule {
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown
  InferenceSession: {
    create(buffer: Buffer, options: Record<string, unknown>): Promise<OrtSession>
  }
}

/** One loaded inference session. */
interface OrtSession {
  /** Names of the inputs the model declares; used to skip optional feeds like `token_type_ids`. */
  readonly inputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtValue>>
}

/** One tensor output. */
interface OrtValue {
  dims: readonly number[]
  data: Float32Array | BigInt64Array
}

/** Tokenizer output in the flat, padded form ONNX expects. */
interface Encoded {
  readonly inputIds: BigInt64Array
  readonly attentionMask: BigInt64Array
  readonly tokenTypeIds: BigInt64Array
  readonly shape: readonly [number, number]
}

/** CJK ranges treated as single tokens, matching BERT's Chinese vocabularies. */
function isCjk(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
}

/** WordPiece tokenizer over a BERT `vocab.txt`. */
class BertTokenizer {
  private readonly vocab = new Map<string, number>()
  private clsId = 101
  private sepId = 102
  private padId = 0
  private unkId = 100

  /**
   * Read a vocabulary file.
   * @param vocabPath - Absolute path of `vocab.txt`.
   * @param maxLength - Maximum sequence length including the special tokens.
   */
  static async fromVocabFile(vocabPath: string, maxLength = 512): Promise<BertTokenizer> {
    const raw = await readFile(vocabPath, 'utf8')
    const tokenizer = new BertTokenizer(maxLength)
    raw.split('\n').forEach((line, index) => {
      const token = line.replace(/\r$/, '')
      if (token !== '') tokenizer.vocab.set(token, index)
    })
    tokenizer.clsId = tokenizer.vocab.get('[CLS]') ?? 101
    tokenizer.sepId = tokenizer.vocab.get('[SEP]') ?? 102
    tokenizer.padId = tokenizer.vocab.get('[PAD]') ?? 0
    tokenizer.unkId = tokenizer.vocab.get('[UNK]') ?? 100
    return tokenizer
  }

  /** @param maxLength - Maximum sequence length including the special tokens. */
  private constructor(private readonly maxLength: number) {}

  /**
   * Encode a batch into padded ONNX tensors.
   * @param texts - Texts to encode.
   * @returns Flat tensors and their `[batch, length]` shape.
   */
  encode(texts: readonly string[]): Encoded {
    const encoded = texts.map(text => this.encodeOne(text))
    const width = encoded.reduce((max, item) => Math.max(max, item.ids.length), 0)
    const batch = encoded.length
    const inputIds = new BigInt64Array(batch * width)
    const attentionMask = new BigInt64Array(batch * width)
    const tokenTypeIds = new BigInt64Array(batch * width)
    encoded.forEach((item, row) => {
      for (let column = 0; column < width; column++) {
        const offset = row * width + column
        inputIds[offset] = BigInt(item.ids[column] ?? this.padId)
        attentionMask[offset] = BigInt(item.ids[column] === undefined ? 0 : 1)
      }
    })
    return { inputIds, attentionMask, tokenTypeIds, shape: [batch, width] }
  }

  /** Tokenize one text into vocabulary ids. */
  private encodeOne(text: string): { ids: number[] } {
    const tokens: string[] = [String(this.clsId)]
    let buffer = ''
    const flush = (): void => {
      if (buffer === '') return
      tokens.push(...this.wordPiece(buffer.toLowerCase()))
      buffer = ''
    }
    for (const ch of text) {
      if (isCjk(ch.codePointAt(0) ?? 0)) {
        flush()
        tokens.push(ch)
      } else if (/\s/.test(ch)) {
        flush()
      } else {
        buffer += ch
      }
    }
    flush()
    if (tokens.length >= this.maxLength) tokens.length = this.maxLength - 1
    tokens.push(String(this.sepId))
    return { ids: tokens.map(token => this.vocab.get(token) ?? this.unkId) }
  }

  /** Greedy longest-match-first WordPiece split. */
  private wordPiece(word: string): string[] {
    if (word.length <= 1) return [word]
    const out: string[] = []
    let start = 0
    while (start < word.length) {
      let end = word.length
      let match: string | null = null
      while (start < end) {
        const candidate = `${start > 0 ? '##' : ''}${word.slice(start, end)}`
        if (this.vocab.has(candidate)) {
          match = candidate
          break
        }
        end--
      }
      if (match === null) return ['[UNK]']
      out.push(match)
      start = end
    }
    return out
  }
}

/** Mean-pooled, L2-normalized sentence embeddings from an ONNX encoder. */
export class Embedder {
  private session: OrtSession | null = null
  private tokenizer: BertTokenizer | null = null
  private outputDim = 0
  private unavailableReason = ''

  /** Width of the vectors this embedder produces; 0 until the model is loaded. */
  get dim(): number {
    return this.outputDim
  }

  /** Whether embeddings are available. */
  get ready(): boolean {
    return this.session !== null && this.tokenizer !== null
  }

  /** Why embeddings are unavailable; empty when they are available. */
  get reason(): string {
    return this.unavailableReason
  }

  /**
   * Load the model, when the deployment configured one.
   * @param modelPath - Absolute path of the `.onnx` model; empty disables embeddings.
   * @param vocabPath - Absolute path of `vocab.txt`; defaults to a sibling of the model.
   * @param expectedDim - Width the deployment expects; a mismatch is refused.
   */
  async init(modelPath: string, vocabPath: string, expectedDim: number): Promise<void> {
    if (modelPath === '') {
      this.unavailableReason = 'no embedding model configured; retrieval is lexical only'
      return
    }
    const ort = await importOptional<OrtModule>('onnxruntime-node')
    if (ort === null) {
      this.unavailableReason = 'onnxruntime-node is not installed; retrieval is lexical only'
      return
    }
    try {
      const resolved = path.resolve(modelPath)
      const session = await ort.InferenceSession.create(
        await readFile(resolved),
        { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
      )
      const tokenizer = await BertTokenizer.fromVocabFile(
        vocabPath === '' ? path.join(path.dirname(resolved), 'vocab.txt') : path.resolve(vocabPath),
      )
      const probe = await session.run(this.feeds(ort, tokenizer.encode(['维度探测']), session.inputNames))
      const output = this.firstOutput(probe)
      this.outputDim = output.dims[output.dims.length - 1] ?? 0
      if (expectedDim > 0 && this.outputDim !== expectedDim) {
        throw new Error(`model outputs ${String(this.outputDim)} dimensions, configured for ${String(expectedDim)}`)
      }
      this.session = session
      this.tokenizer = tokenizer
      this.unavailableReason = ''
    } catch (error) {
      this.session = null
      this.tokenizer = null
      this.outputDim = 0
      this.unavailableReason = `embedding model unavailable (${String(error)}); retrieval is lexical only`
    }
  }

  /**
   * Embed a batch of texts as mean-pooled, normalized vectors.
   * @param texts - Texts to embed.
   * @returns One vector per text, or null when no model is loaded.
   */
  async embed(texts: readonly string[]): Promise<Float32Array[] | null> {
    const session = this.session
    const tokenizer = this.tokenizer
    if (session === null || tokenizer === null || texts.length === 0) return null
    const ort = await importOptional<OrtModule>('onnxruntime-node')
    if (ort === null) return null

    const results: Float32Array[] = []
    for (let offset = 0; offset < texts.length; offset += 8) {
      const batch = texts.slice(offset, offset + 8)
      const encoded = tokenizer.encode(batch)
      const output = this.firstOutput(await session.run(this.feeds(ort, encoded, session.inputNames)))
      const width = output.dims[output.dims.length - 1] ?? 0
      const rows = output.dims[1] ?? batch.length
      const data = output.data instanceof Float32Array ? output.data : new Float32Array(0)
      for (let row = 0; row < batch.length; row++) {
        const vector = new Float32Array(width)
        let counted = 0
        for (let token = 0; token < rows; token++) {
          if (encoded.attentionMask[row * rows + token] === 0n) continue
          counted++
          const base = row * rows * width + token * width
          for (let d = 0; d < width; d++) vector[d] += data[base + d] ?? 0
        }
        results.push(normalize(vector, Math.max(counted, 1)))
      }
    }
    return results
  }

  /**
   * Build the ONNX feeds a BERT encoder expects.
   * @param ort - The onnxruntime module.
   * @param encoded - Tokenized inputs.
   * @param inputNames - Input names the loaded session declares.
   * @returns Feeds keyed by the names the model actually accepts.
   */
  private feeds(ort: OrtModule, encoded: Encoded, inputNames: readonly string[]): Record<string, unknown> {
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', encoded.inputIds, encoded.shape),
      attention_mask: new ort.Tensor('int64', encoded.attentionMask, encoded.shape),
    }
    // Some exports drop `token_type_ids`; skip it when absent so those models still run.
    if (inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', encoded.tokenTypeIds, encoded.shape)
    }
    return feeds
  }

  /** Pick the hidden-state output, whichever name the model exports it under. */
  private firstOutput(outputs: Record<string, OrtValue>): OrtValue {
    const named = outputs['last_hidden_state'] ?? outputs['token_embeddings']
    if (named !== undefined) return named
    const values = Object.values(outputs)
    if (values.length === 0) throw new Error('model produced no output')
    return values[0] as OrtValue
  }
}

/** Divide by the token count, then by the L2 norm. */
function normalize(vector: Float32Array, count: number): Float32Array {
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / count
  let norm = 0
  for (const value of vector) norm += value * value
  const scale = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / scale
  return vector
}
