// Downloads the PP-OCRv6 ONNX models into the package's `models/ppocr/` directory so they ship
// inside the tarball: `pnpm pack` (via the prepack hook) fetches anything missing, and a profile
// installing the tarball gets PP-OCR with zero setup. The repo paths, byte sizes and SHA-256s
// below were pinned from the official `PaddlePaddle/*_onnx` HuggingFace trees (Apache-2.0).
//
// Usage:  node scripts/fetch-models.mjs [--tier tiny|small|medium] [--force]
// Idempotent: with everything present and matching, the run costs a few hash checks and no I/O.
// `models/` is git-ignored on purpose — the binaries belong to the artifact, not the checkout.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'models', 'ppocr')
const manifestPath = path.join(outDir, 'models.json')

/** Try the domestic mirror first; the bare host usually resets connections from CN networks. */
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

/** Model tiers keyed by name; `size`/`sha256` are the pinned LFS digests of `inference.onnx`. */
const TIERS = {
  tiny: {
    det: { repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx', size: 1_780_590, sha256: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8' },
    rec: { repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx', size: 4_462_639, sha256: '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6' },
  },
  small: {
    det: { repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx', size: 9_880_512, sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e' },
    rec: { repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx', size: 21_159_378, sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
  },
  medium: {
    det: { repo: 'PaddlePaddle/PP-OCRv6_medium_det_onnx', size: 62_032_837, sha256: 'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1' },
    rec: { repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx', size: 76_554_979, sha256: '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba' },
  },
}

const args = process.argv.slice(2)
const tier = (() => {
  const at = args.indexOf('--tier')
  const value = at >= 0 ? args[at + 1] : 'small'
  if (!TIERS[value]) fail(`unknown --tier ${JSON.stringify(String(value))}; expected tiny|small|medium`)
  return value
})()
const force = args.includes('--force')

/** Abort with a one-line message; prepack treats this as a hard failure. */
function fail(message) {
  console.error(`[fetch-models] ${message}`)
  process.exit(1)
}

/** SHA-256 of a file, hex (whole-file read: the largest tier is well under memory limits). */
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

/** Fetch one URL to a temp path, verifying size and digest; returns the bytes or null. */
async function download(url, expected) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    console.log(`[fetch-models]   ...${error instanceof Error ? error.message : error}`)
    return null
  }
  if (!response.ok) {
    console.log(`[fetch-models]   ...HTTP ${response.status}`)
    return null
  }
  const target = path.join(outDir, `.part-${Math.random().toString(36).slice(2)}`)
  try {
    // pipeline() settles on errors from either side — mirrors reset big transfers at random.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
    if ((await stat(target)).size !== expected.size) throw new Error('size mismatch')
    if ((await sha256(target)) !== expected.sha256) throw new Error('digest mismatch')
    return target
  } catch (error) {
    await rm(target, { force: true })
    console.log(`[fetch-models]   ...${error instanceof Error ? error.message : error}`)
    return null
  }
}

/** Download `repo`'s `inference.onnx` into place; two attempts per mirror before giving up. */
async function fetchModel(repo, expected, dest) {
  for (const base of MIRRORS) {
    const url = `${base}/${repo}/resolve/main/inference.onnx`
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[fetch-models] GET ${url}${attempt > 1 ? ` (retry ${attempt})` : ''}`)
      const temp = await download(url, expected)
      if (temp !== null) {
        await rename(temp, dest)
        return
      }
    }
  }
  fail(`could not fetch ${repo} (all mirrors and retries)`)
}

/**
 * Extract a model tier's `character_dict` from its sidecar `inference.yml`.
 *
 * The dict is the authoritative, tier-matched character list: each entry becomes one line of
 * `rec.dict.txt` (class index = line + 1, class 0 being the CTC blank the engine prepends).
 * Entries appear quoted (`'!'`) or bare (`- $`, or the bare U+3000 ideographic space — so the
 * captured value must never be trimmed). The dumped dict omits the trailing ASCII space that
 * PaddleOCR's `use_space_char` adds as an extra CTC class; {@link reconcileSpaceChar} appends it.
 */
async function extractDict(repo) {
  let text = null
  for (const base of MIRRORS) {
    try {
      const response = await fetch(`${base}/${repo}/resolve/main/inference.yml`, { redirect: 'follow' })
      if (response.ok) {
        text = await response.text()
        break
      }
    } catch {
      // try the next mirror
    }
  }
  if (text === null) fail(`could not fetch ${repo} inference.yml (all mirrors)`)
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((line) => /^\s*character_dict:\s*$/.test(line))
  if (at < 0) fail(`${repo} inference.yml has no character_dict`)
  const chars = []
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+- ?(.*)$/.exec(line)
    if (item === null) {
      if (line.trim() === '') continue
      break
    }
    chars.push(decodeYamlScalar(item[1]))
  }
  if (chars.length < 1000 || !chars.includes('中')) fail(`${repo} character_dict looks malformed (${chars.length} entries)`)
  return chars
}

/** Decode one YAML block scalar as dumped by pyyaml for single characters. */
function decodeYamlScalar(raw) {
  // Only the separator space was already consumed by the regex; the value keeps its own
  // whitespace (a bare entry of U+3000 IS the ideographic space character).
  if (raw === '' || raw === '~' || raw === 'null') return ''
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

/**
 * Make the dict cover every CTC class of the actual rec model, verified by a micro-inference.
 *
 * PaddleOCR recognition heads emit `1 blank + dict chars (+ 1 trailing space class when
 * `use_space_char`)`; the yml dict never lists the trailing space. If the model's class count is
 * one larger than blank+dict, append the ASCII space. The probe runs in a child process because
 * a native ONNX Runtime fault kills the process outright — the pack must survive that.
 */
function probeClasses(recFile) {
  const code = "import('onnxruntime-node').then(async (ort) => {\n"
    + '  const s = await ort.InferenceSession.create(process.env.PROBE_MODEL, { executionProviders: [\'cpu\'] })\n'
    + '  const t = new ort.Tensor(\'float32\', new Float32Array(3 * 48 * 320), [1, 3, 48, 320])\n'
    + '  const o = await s.run({ [s.inputNames[0]]: t })\n'
    + '  const v = Object.values(o)[0]\n'
    + '  console.log(String(Number(v.dims[v.dims.length - 1])))\n'
    + '}).catch(() => process.exit(2))\n'
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PROBE_MODEL: recFile }, timeout: 120_000,
  })
  const classes = Number.parseInt(probe.stdout ?? '', 10)
  return Number.isFinite(classes) ? classes : null
}

function reconcileSpaceChar(recFile, chars) {
  const classes = probeClasses(recFile)
  if (classes === null) {
    // No probe: apply the PaddleOCR rule blindly but safely — a PaddleOCR rec head always adds a
    // trailing space class the yml dict omits, and an extra dict line that no class ever points
    // at is inert, whereas a missing one silently drops spaces. So: append unless already present.
    if (!chars.includes(' ')) {
      chars.push(' ')
      console.log('[fetch-models] probe unavailable; appending trailing space class by convention (harmless if the model lacks it)')
    } else {
      console.log('[fetch-models] probe unavailable; dict already carries a space entry')
    }
    return
  }
  if (classes === chars.length + 2 && !chars.includes(' ')) {
    chars.push(' ')
    console.log(`[fetch-models] appended trailing space class (model emits ${classes} CTC classes)`)
  } else if (classes !== chars.length + 1 && classes !== chars.length + 2) {
    console.log(`[fetch-models] WARNING: dict of ${chars.length} chars does not line up with ${classes} CTC classes`)
  } else {
    console.log(`[fetch-models] CTC classes verified: ${classes}`)
  }
}

/** Provenance record written next to the models; the idempotence key for later runs. */
async function writeManifest(record) {
  await writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  // Sweep temp remnants of interrupted runs so a crash never leaks `.part-*` files into the pack.
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith('.part-')) await rm(path.join(outDir, entry), { force: true })
  }
  const spec = TIERS[tier]
  const files = { det: path.join(outDir, 'det.onnx'), rec: path.join(outDir, 'rec.onnx'), dict: path.join(outDir, 'rec.dict.txt') }
  let previous = null
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    // first run
  }
  const fresh = previous !== null && previous.tier === tier &&
    (await matches(files.det, spec.det)) && (await matches(files.rec, spec.rec)) &&
    existsSync(files.dict)
  if (fresh && !force) {
    console.log(`[fetch-models] PP-OCRv6 ${tier} models already present and verified in models/ppocr`)
    return
  }
  console.log(`[fetch-models] fetching PP-OCRv6_${tier} det/rec into models/ppocr`)
  // Per-file idempotence: a damaged or missing file is refetched, verified ones stay put even
  // under --force (which only skips the whole-directory early return and rebuilds the dict).
  for (const [kind, dest] of [['det', files.det], ['rec', files.rec]]) {
    if (await matches(dest, spec[kind])) {
      console.log(`[fetch-models] ${kind}.onnx already present and verified`)
      continue
    }
    await fetchModel(spec[kind].repo, spec[kind], dest)
  }
  const chars = await extractDict(spec.rec.repo)
  reconcileSpaceChar(files.rec, chars)
  await writeFile(files.dict, `${chars.join('\n')}\n`)
  await writeManifest({
    tier,
    fetchedAt: new Date().toISOString(),
    license: 'Apache-2.0 (PaddleOCR)',
    dictChars: chars.length,
    det: { ...spec.det, file: 'det.onnx' },
    rec: { ...spec.rec, file: 'rec.onnx' },
  })
  console.log(`[fetch-models] done: det ${(spec.det.size / 1e6).toFixed(1)} MB, rec ${(spec.rec.size / 1e6).toFixed(1)} MB, dict ${chars.length} chars`)
}

main().catch((error) => fail(String(error instanceof Error ? error.stack : error)))
