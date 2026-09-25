// Downloads the bundled embedding model into `models/embed/` so it ships inside the tarball:
// `pnpm pack` (via the prepack hook) fetches it when missing, and a profile installing the tarball
// gets semantic retrieval with zero setup and no network at install time.
//
// The model is a BERT-family sentence transformer with a WordPiece `vocab.txt` and a
// `last_hidden_state` output — exactly what `src/features/embedder.ts` expects (mean-pool + L2):
//   - repo `Xenova/bge-small-zh-v1.5` (Apache-2.0) ships both `onnx/model.onnx` (~95 MB fp32) and a
//     root `vocab.txt`, which the embedder needs. The `BAAI/bge-small-zh-v1.5` source repo has the
//     vocab but no ONNX export, so the ONNX-ready `Xenova` mirror is used.
//   - 512-dimensional, strong for Chinese/English standards and term retrieval (this plugin's workload).
//
// Usage:  node scripts/fetch-embed-model.mjs [--force]
// Idempotent: a present, verified model.onnx is left untouched.
//
// Verification: the authoritative size+sha256 come from the repo's Git-LFS pointer (`/raw/main/...`).
// When the pointer is reachable we check both strictly; when it is not (mirror hiccup) we fall back to
// a structural check (a real ONNX is a multi-MB binary, never the tiny LFS pointer text) so packing
// still succeeds. Run with no args after a fetch to confirm the local copy is accepted as `fresh`.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'models', 'embed')
const metaPath = path.join(outDir, 'MODEL_INFO.txt')

// Domestic mirror first: the bare host often resets connections from CN networks.
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']
const REPO = 'Xenova/bge-small-zh-v1.5'
const ONNX_FILE = 'onnx/model.onnx'
const VOCAB_FILE = 'vocab.txt'
// A real `model.onnx` is tens of MB; an LFS pointer is a few hundred bytes. This floor rejects the
// pointer text (or an HTML error page) so a corrupted fetch is never mistaken for a valid model.
const MIN_ONNX_BYTES = 10_000_000

const args = process.argv.slice(2)
const force = args.includes('--force')

function fail(message) {
  console.error(`[fetch-embed] ${message}`)
  process.exit(1)
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function matches(file, expected) {
  try {
    if ((await stat(file)).size !== expected.size) return false
    return (await sha256(file)) === expected.sha256
  } catch {
    return false
  }
}

/**
 * Whether a file looks like a real ONNX model: large enough and not a Git-LFS pointer/error page.
 * Used when the authoritative LFS digest is unreachable, so packing still has a safety net.
 */
async function isValidOnnx(file) {
  try {
    const info = await stat(file)
    if (info.size < MIN_ONNX_BYTES) return false
    const handle = await open(file, 'r')
    try {
      const head = Buffer.alloc(64)
      await handle.read(head, 0, 64, 0)
      if (head.toString('latin1').startsWith('version https://git-lfs')) return false
      return true
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/**
 * Read the Git-LFS pointer of a file to learn its authoritative size and sha256.
 * @returns The pinned size and digest, or null when the endpoint is unavailable.
 */
async function lfsPointer(repo, filePath) {
  for (const base of MIRRORS) {
    try {
      const response = await fetch(`${base}/${repo}/raw/main/${filePath}`, { redirect: 'follow' })
      if (!response.ok) continue
      const text = await response.text()
      const digest = /oid sha256:([0-9a-f]{64})/i.exec(text)?.[1]
      const size = Number.parseInt(/size (\d+)/.exec(text)?.[1] ?? '', 10)
      if (digest && Number.isFinite(size)) return { sha256: digest.toLowerCase(), size }
    } catch {
      // try the next mirror
    }
  }
  return null
}

/** Fetch one URL to a temp file, verifying against `expected` (or structurally when null). */
async function download(url, expected) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    console.log(`[fetch-embed]   ...${error instanceof Error ? error.message : error}`)
    return null
  }
  if (!response.ok) {
    console.log(`[fetch-embed]   ...HTTP ${response.status}`)
    return null
  }
  const target = path.join(outDir, `.part-${Math.random().toString(36).slice(2)}`)
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
    if (expected !== null) {
      if ((await stat(target)).size !== expected.size) throw new Error('size mismatch')
      if ((await sha256(target)) !== expected.sha256) throw new Error('digest mismatch')
    } else if (!await isValidOnnx(target)) {
      throw new Error('downloaded file is not a valid ONNX (LFS pointer or error page?)')
    }
    return target
  } catch (error) {
    await rm(target, { force: true })
    console.log(`[fetch-embed]   ...${error instanceof Error ? error.message : error}`)
    return null
  }
}

/** Download `path` from the repo, two attempts per mirror, verifying against the LFS pointer. */
async function fetchFile(repo, filePath, dest) {
  const expected = await lfsPointer(repo, filePath)
  if (expected === null) {
    console.log('[fetch-embed] WARNING: could not read LFS pointer; will verify by file type/size only')
  }
  for (const base of MIRRORS) {
    const url = `${base}/${repo}/resolve/main/${filePath}`
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[fetch-embed] GET ${url}${attempt > 1 ? ` (retry ${attempt})` : ''}`)
      const temp = await download(url, expected)
      if (temp !== null) {
        await rm(dest, { force: true })
        await rename(temp, dest)
        return
      }
    }
  }
  fail(`could not fetch ${filePath} (all mirrors and retries)`)
}

/** vocab.txt is plain text (not LFS): fetch it without a digest, accept once it is non-trivial. */
async function fetchVocab(repo, filePath, dest) {
  for (const base of MIRRORS) {
    const url = `${base}/${repo}/raw/main/${filePath}`
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) continue
      const text = await response.text()
      if (text.length < 1000) throw new Error('vocab too small; likely an error page')
      await writeFile(dest, text, 'utf8')
      return
    } catch (error) {
      console.log(`[fetch-embed]   ...${error instanceof Error ? error.message : error}`)
    }
  }
  fail(`could not fetch ${filePath} (all mirrors)`)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith('.part-')) await rm(path.join(outDir, entry), { force: true })
  }
  const onnxDest = path.join(outDir, 'model.onnx')
  const vocabDest = path.join(outDir, 'vocab.txt')

  const pointer = await lfsPointer(REPO, ONNX_FILE)
  // Idempotence: accept a present copy either by strict digest (when known) or by structural check.
  let fresh = existsSync(onnxDest) && existsSync(vocabDest)
  if (pointer !== null) fresh = fresh && (await matches(onnxDest, pointer))
  else fresh = fresh && (await isValidOnnx(onnxDest))
  if (fresh && !force) {
    const how = pointer !== null ? 'and verified against LFS digest' : 'and structurally valid'
    console.log(`[fetch-embed] ${REPO} already present ${how} in models/embed`)
    return
  }

  console.log(`[fetch-embed] fetching ${REPO} into models/embed`)
  await fetchFile(REPO, ONNX_FILE, onnxDest)
  await fetchVocab(REPO, VOCAB_FILE, vocabDest)
  const verified = pointer !== null ? `sha256 ${pointer.sha256}` : 'structural check only (LFS pointer unavailable)'
  await writeFile(metaPath, [
    'Bundled embedding model for llm-wiki (semantic retrieval).',
    `repo:  ${REPO}`,
    'files: model.onnx (BERT ONNX, mean-pooled, L2-normalized) + vocab.txt (WordPiece)',
    'dims:  512',
    'license: Apache-2.0 (BAAI bge-small-zh-v1.5, ONNX export by Xenova)',
    `verified: ${verified}`,
    'fetched by scripts/fetch-embed-model.mjs (run at pack time).',
  ].join('\n') + '\n')
  const size = ((await stat(onnxDest)).size / 1e6).toFixed(1)
  const tokens = String((await readFile(vocabDest, 'utf8')).split('\n').length)
  console.log(`[fetch-embed] done: model.onnx ${size} MB (${((await stat(onnxDest)).size).toLocaleString()} bytes), vocab.txt ${tokens} tokens`)
}

main().catch((error) => fail(String(error instanceof Error ? error.stack : error)))
