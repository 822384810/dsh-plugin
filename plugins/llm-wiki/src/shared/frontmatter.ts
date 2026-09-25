/**
 * YAML frontmatter parsing for Wiki pages.
 *
 * Only the flat `key: value` subset the schema actually prescribes is supported; anything
 * richer would need a YAML parser for no benefit, since the pages are generated here.
 */

/** Frontmatter fields as flat strings. */
export type Frontmatter = Readonly<Record<string, string>>

/**
 * Read the leading `---` block of a Markdown document.
 * @param content - Full page content.
 * @returns The parsed fields; empty when the document has no frontmatter block.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (match === null) return {}
  const result: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '') continue
    result[key] = unquote(line.slice(separator + 1).trim())
  }
  return result
}

/**
 * Drop the leading frontmatter block, leaving the body.
 * @param content - Full page content.
 * @returns The body, or the content unchanged when it carries no frontmatter.
 */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

/**
 * Render a frontmatter block, escaping values that would otherwise break the block.
 * @param fields - Fields in the order they should appear.
 * @returns A complete `---` delimited block without a trailing newline.
 */
export function renderFrontmatter(fields: ReadonlyArray<readonly [string, string]>): string {
  const lines = ['---']
  for (const [key, value] of fields) {
    lines.push(`${key}: ${escapeValue(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** Strip one layer of matching quotes. */
function unquote(value: string): string {
  const quote = value.charAt(0)
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

/** Quote values that contain characters the flat format cannot carry. */
function escapeValue(value: string): string {
  return /[:#\r\n]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}
