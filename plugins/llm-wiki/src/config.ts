/**
 * Deployment-tunable settings.
 *
 * The bundle patch writes these under the plugin row in `cordis.patch.yml`; cordis hands the
 * raw object to `apply(ctx, config)`. Defaults live here rather than in a schema so that a
 * missing key (an older patch file, a hand-edited profile) keeps the plugin working.
 */
import { fileURLToPath } from 'node:url'
import { dshHomePath } from './shared/home.ts'

/** One knowledge base the deployment wants registered at start-up. */
export interface LibrarySeed {
  /** Stable id; generated from `name` when omitted. */
  readonly id?: string
  /** Display name; defaults to the last segment of `rootDir`. */
  readonly name?: string
  /** Absolute directory that holds `raw/` and `wiki/`. */
  readonly rootDir: string
}

/** Settings as written in `cordis.patch.yml`: every field optional. */
export interface Config {
  /** Knowledge bases registered on first start; later edits persist to the registry. */
  readonly libraries?: readonly LibrarySeed[]
  /** Where the library registry is stored; defaults to `$DSH_HOME/storages/llm-wiki/registry.json`. */
  readonly registryPath?: string
  /** Upper bound on characters per chunk, the section line it opens with included. */
  readonly chunkSize?: number
  /** Characters a chunk may repeat from the one before it; must be smaller than `chunkSize`. */
  readonly chunkOverlap?: number
  /** Hits returned by a hybrid search. */
  readonly topK?: number
  /** Watch `raw/` and ingest new or changed files automatically. */
  readonly watch?: boolean
  /** Optional ONNX embedding model; without it retrieval is lexical only. */
  readonly embeddingModelPath?: string
  /** Optional `vocab.txt`; defaults to a sibling of the model file. */
  readonly embeddingVocabPath?: string
  /** Expected embedding width; a model that disagrees is refused. */
  readonly embeddingDim?: number
  /** Tesseract languages used for scanned PDFs (fallback engine). */
  readonly ocrLanguages?: string
  /**
   * Directory (or URL) holding Tesseract `<lang>.traineddata.gz` files.
   * Empty means the data bundled in the plugin's `tessdata/` directory.
   */
  readonly ocrLangPath?: string
  /**
   * OCR engine for scanned/garbled PDFs: `ppocr`, `tesseract`, or `auto` (the default) which
   * uses PP-OCR when usable models resolve — the ones bundled in the package or an
   * `ocrModelDir` override — and otherwise falls back to Tesseract. PP-OCR runs on the CPU
   * through `onnxruntime-node`, the same runtime as embeddings.
   */
  readonly ocrEngine?: 'auto' | 'ppocr' | 'tesseract'
  /**
   * Directory holding the PP-OCR ONNX files: `det.onnx`, `rec.onnx`, `rec.dict.txt` and the
   * optional `cls.onnx`. Empty (the default) uses the official PP-OCRv6 models bundled with
   * the package under `models/ppocr/`; point elsewhere to swap tier or bring custom models.
   */
  readonly ocrModelDir?: string
  /**
   * Rasterization scale for the PP-OCR path; higher keeps small print legible. Default 3 — the scale
   * the Tesseract path already uses for pages carrying a table, which is where print is smallest.
   * Cost grows with the square of the scale, so a scan whose text is already large is better read at
   * 2 than at 4.
   */
  readonly ocrRenderScale?: number
  /**
   * Extra file extensions to accept as plain-text sources, beyond the built-in set.
   * Entries may be written with or without the leading dot (e.g. `rst` or `.rst`).
   */
  readonly extraSourceExtensions?: readonly string[]
  /** Hits injected into the system prompt by ambient recall. */
  readonly ambientTopK?: number
  /** Character budget for the ambient-recall block. */
  readonly ambientMaxChars?: number
  /** Provider route used for the optional LLM-assisted Wiki compile. */
  readonly compileProvider?: string
  /** Model used for the optional LLM-assisted Wiki compile. */
  readonly compileModel?: string
  /** Characters of source text handed to the model per compile call. */
  readonly compileWindowChars?: number
  /** Upper bound on compile windows per source; the remainder is skipped with a warning. */
  readonly compileMaxWindows?: number
  /** Output-token ceiling for one window's page plan. */
  readonly compileMaxTokens?: number
  /** Upload size ceiling in bytes. */
  readonly maxUploadBytes?: number
}

/** Settings with every default applied. */
export interface Settings {
  readonly libraries: readonly LibrarySeed[]
  readonly registryPath: string
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly topK: number
  readonly watch: boolean
  readonly embeddingModelPath: string
  readonly embeddingVocabPath: string
  readonly embeddingDim: number
  readonly ocrLanguages: string
  readonly ocrLangPath: string
  readonly ocrEngine: 'auto' | 'ppocr' | 'tesseract'
  readonly ocrModelDir: string
  readonly ocrRenderScale: number
  readonly extraSourceExtensions: readonly string[]
  readonly ambientTopK: number
  readonly ambientMaxChars: number
  readonly compileProvider: string
  readonly compileModel: string
  readonly compileWindowChars: number
  readonly compileMaxWindows: number
  readonly compileMaxTokens: number
  readonly maxUploadBytes: number
}

/** Default registry location: `$DSH_HOME/storages/llm-wiki/registry.json`. */
export const DEFAULT_REGISTRY_PATH = dshHomePath('storages', 'llm-wiki', 'registry.json')

/**
 * Default embedding model, bundled inside the package.
 *
 * `model.onnx` plus a sibling `vocab.txt` live under `models/embed/` and are fetched at pack time
 * (see `scripts/fetch-embed-model.mjs`, run by the `prepack` hook), so an install ships with them and
 * needs no network at install time. The path resolves against this file's location, which after the
 * bundle build is `<package>/lib/config.js`, putting the model at `<package>/models/embed/model.onnx`.
 * When the file is absent `embedder.init` degrades to lexical-only and logs a warning, so the plugin
 * still runs.
 */
export const DEFAULT_EMBED_MODEL_PATH = fileURLToPath(new URL('../models/embed/model.onnx', import.meta.url))

/** Guard against a nonsense overlap swallowing the whole chunk stride. */
function sanitizeChunking(chunkSize: number | undefined, chunkOverlap: number | undefined): [number, number] {
  const size = Number.isFinite(chunkSize) ? Math.trunc(chunkSize as number) : 800
  const overlap = Number.isFinite(chunkOverlap) ? Math.trunc(chunkOverlap as number) : 100
  const safeSize = Math.min(Math.max(size, 64), 8000)
  return [safeSize, Math.min(Math.max(overlap, 0), safeSize - 1)]
}

/** Read a positive integer setting, falling back when it is absent or invalid. */
function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : fallback
}

/** Trim an optional string setting; empty strings count as absent. */
function text(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Normalize an extension list to lowercase, dot-prefixed, de-duplicated entries.
 * @param list - Raw entries, with or without a leading dot.
 * @returns The normalized extensions.
 */
function normalizeExtensions(list: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(list)) return []
  const out = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().toLowerCase()
    if (trimmed === '') continue
    out.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`)
  }
  return [...out]
}

/**
 * Apply defaults to the raw bundle-patch config.
 * @param config - Settings as written in `cordis.patch.yml`.
 * @returns Fully-populated {@link Settings}.
 */
export function resolveSettings(config: Config = {}): Settings {
  const [chunkSize, chunkOverlap] = sanitizeChunking(config.chunkSize, config.chunkOverlap)
  return {
    libraries: Array.isArray(config.libraries) ? config.libraries : [],
    registryPath: text(config.registryPath, DEFAULT_REGISTRY_PATH),
    chunkSize,
    chunkOverlap,
    topK: positive(config.topK, 10),
    watch: config.watch ?? true,
    embeddingModelPath: text(config.embeddingModelPath, DEFAULT_EMBED_MODEL_PATH),
    embeddingVocabPath: text(config.embeddingVocabPath, ''),
    embeddingDim: positive(config.embeddingDim, 512),
    ocrLanguages: text(config.ocrLanguages, 'chi_sim+eng'),
    ocrLangPath: text(config.ocrLangPath, ''),
    ocrEngine: config.ocrEngine === 'ppocr' || config.ocrEngine === 'tesseract' ? config.ocrEngine : 'auto',
    ocrModelDir: text(config.ocrModelDir, ''),
    ocrRenderScale: Number.isFinite(config.ocrRenderScale) && (config.ocrRenderScale as number) > 0
      ? Math.min(config.ocrRenderScale as number, 6)
      : 3,
    extraSourceExtensions: normalizeExtensions(config.extraSourceExtensions),
    ambientTopK: positive(config.ambientTopK, 5),
    ambientMaxChars: positive(config.ambientMaxChars, 2000),
    compileProvider: text(config.compileProvider, ''),
    compileModel: text(config.compileModel, ''),
    compileWindowChars: positive(config.compileWindowChars, 20000),
    compileMaxWindows: positive(config.compileMaxWindows, 200),
    compileMaxTokens: positive(config.compileMaxTokens, 8000),
    maxUploadBytes: positive(config.maxUploadBytes, 100 * 1024 * 1024),
  }
}
