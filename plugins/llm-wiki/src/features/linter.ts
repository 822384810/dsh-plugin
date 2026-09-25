/**
 * Knowledge-base health check.
 *
 * The compiler can leave a library in a state no schema check catches: a page with no
 * frontmatter, or a link to a page that no longer exists. `/wiki-lint` reports those so they
 * can be fixed before they mislead a retrieval.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { listWikiPages } from './pages.ts'

/**
 * Check the Wiki for missing frontmatter and broken links.
 * @param wikiDir - Absolute Wiki directory.
 * @returns A human-readable report.
 */
export async function lintWiki(wikiDir: string): Promise<string> {
  const pages = await listWikiPages(wikiDir)
  const issues: string[] = []
  const titles = new Set(pages.map(page => page.title))
  const paths = pages.map(page => page.path)

  for (const page of pages) {
    if (page.title === '') issues.push(`缺少 title: ${page.path}`)
    if (page.type === 'unknown') issues.push(`缺少 type: ${page.path}`)
    if (page.updated === '') issues.push(`缺少 updated: ${page.path}`)
  }

  for (const page of pages) {
    const content = await readFile(path.join(wikiDir, page.path), 'utf8').catch(() => '')
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1] ?? ''
      if (titles.has(target)) continue
      if (paths.some(candidate => candidate.includes(target))) continue
      issues.push(`断链: ${page.path} → [[${target}]]`)
    }
  }

  if (issues.length === 0) return '知识库健康检查通过，未发现问题。'
  return `发现 ${String(issues.length)} 个问题：\n\n${issues.map(issue => `- ${issue}`).join('\n')}`
}
