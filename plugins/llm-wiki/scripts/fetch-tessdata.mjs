// Downloads the Tesseract language data into `tessdata/` so scanned-PDF OCR works offline.
// tesseract.js normally pulls these from a CDN, which is unreachable from some networks;
// `src/features/parsers.ts` prefers this local directory when it exists.
//
// Like `models/`, `tessdata/` is git-ignored: run `pnpm fetch-tessdata` to download the packs
// ahead of time, and the `prepack` hook re-checks them before `pnpm pack` puts the directory
// into the tarball — an install of the tarball then needs no network and no manual step.
//
// Sizes and SHA-256s are pinned to the `tessdata.projectnaptha.com/4.0.0` packs — the same
// language data the harness server module uses, so OCR output matches across both systems.
// Usage:  node scripts/fetch-tessdata.mjs [--force]
// Idempotent: files already matching size + digest are left untouched.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(root, '..', 'tessdata')

/** Languages the plugin requests by default (`ocrLanguages: chi_sim+eng`). */
const LANGS = {
  chi_sim: { size: 20_159_757, sha256: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6' },
  eng: { size: 10_923_060, sha256: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468' },
}
const BASE = 'https://tessdata.projectnaptha.com/4.0.0'

const force = process.argv.includes('--force')

/** Abort with a one-line message. */
function fail(message) {
  console.error(`[fetch-tessdata] ${message}`)
  process.exit(1)
}

/** SHA-256 of a file, hex. */
async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** Whether the file already matches the pinned size and digest. */
async function matches(file, expected) {
  try {
    if ((await stat(file)).size !== expected.size) return false
    return (await sha256(file)) === expected.sha256
  } catch {
    return false
  }
}

/** Fetch one language pack to a temp path, verifying size and digest. */
async function download(lang, expected) {
  const url = `${BASE}/${lang}.traineddata.gz`
  console.log(`[fetch-tessdata] ${lang}: GET ${url}`)
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    console.log(`[fetch-tessdata]   ...${error instanceof Error ? error.message : error}`)
    return false
  }
  if (!response.ok) {
    console.log(`[fetch-tessdata]   ...HTTP ${response.status}`)
    return false
  }
  const target = path.join(outDir, `.part-${lang}`)
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
    if ((await stat(target)).size !== expected.size) throw new Error('size mismatch')
    if ((await sha256(target)) !== expected.sha256) throw new Error('digest mismatch')
    await rm(path.join(outDir, `${lang}.traineddata.gz`), { force: true })
    await rename(target, path.join(outDir, `${lang}.traineddata.gz`))
    console.log(`[fetch-tessdata] ${lang}: ok`)
    return true
  } catch (error) {
    console.log(`[fetch-tessdata]   ...${error instanceof Error ? error.message : error}`)
    await rm(target, { force: true })
    return false
  }
}

await mkdir(outDir, { recursive: true })
let failed = 0
for (const [lang, expected] of Object.entries(LANGS)) {
  const file = path.join(outDir, `${lang}.traineddata.gz`)
  if (!force && await matches(file, expected)) {
    console.log(`[fetch-tessdata] ${lang}: present`)
    continue
  }
  if (!await download(lang, expected)) failed++
}
if (failed > 0) {
  fail(`${failed} language pack(s) missing; keep a local copy and set WIKI_OCR_LANG_PATH if the network is blocked`)
}
console.log(`[fetch-tessdata] done -> ${outDir}`)
