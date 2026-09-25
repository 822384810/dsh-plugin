/**
 * Path handling shared by every file operation in this plugin.
 *
 * Both halves of the plugin accept paths from an untrusted caller (the model, through a tool,
 * and the browser, through RPC), so every one of them is resolved inside a library root before
 * it touches the filesystem.
 */
import path from 'node:path'

/**
 * Resolve a caller-supplied relative path inside `rootDir`, refusing anything that escapes.
 * @param rootDir - Library root that bounds the result.
 * @param relPath - Caller-supplied relative path.
 * @param allowedPrefixes - Optional POSIX prefixes the result must sit under, e.g. `['raw/']`.
 * @returns The absolute resolved path.
 * @throws when the path is empty, absolute, escapes the root, or misses every allowed prefix.
 */
export function safeResolve(rootDir: string, relPath: string, allowedPrefixes?: readonly string[]): string {
  if (typeof relPath !== 'string' || relPath === '') throw new Error('path is required')
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`absolute paths are rejected: ${relPath}`)
  }
  const root = path.resolve(rootDir)
  const full = path.resolve(root, relPath)
  const rel = path.relative(root, full)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the library root: ${relPath}`)
  }
  if (allowedPrefixes !== undefined && allowedPrefixes.length > 0) {
    const posix = toPosix(rel)
    const ok = allowedPrefixes.some(prefix => posix === trimSlash(prefix) || posix.startsWith(prefix))
    if (!ok) throw new Error(`path is outside ${allowedPrefixes.join(', ')}: ${relPath}`)
  }
  return full
}

/**
 * Reduce a file name to a single safe path segment.
 * @param name - Caller-supplied file name.
 * @returns The sanitized base name.
 * @throws when nothing usable remains.
 */
export function sanitizeFileName(name: string): string {
  const base = path.basename(String(name ?? '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  if (base === '' || base === '.' || base === '..') throw new Error('illegal file name')
  return base
}

/**
 * Normalize a path to POSIX separators so prefix rules behave the same on Windows.
 * @param value - Path to normalize.
 * @returns The path with `\` replaced by `/`.
 */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Express an absolute path relative to a root, in POSIX form.
 * @param rootDir - Root to measure from.
 * @param fullPath - Absolute path inside the root.
 * @returns The relative POSIX path.
 */
export function relativePosix(rootDir: string, fullPath: string): string {
  return toPosix(path.relative(path.resolve(rootDir), path.resolve(fullPath)))
}

/** Drop one trailing slash so `raw/` compares equal to `raw`. */
function trimSlash(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}
