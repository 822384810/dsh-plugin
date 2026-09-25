/**
 * `schema.md` — the third Karpathy layer: the rules telling the LLM how to maintain the Wiki.
 *
 * The file is a human-readable Markdown document, so it is parsed by section rather than
 * converted to a hidden format: what the maintainer edits in the UI is what the compiler reads.
 */

/** How the compiler reacts when new content contradicts an existing page. */
export type ConflictBehavior = 'mark' | 'reject' | 'overwrite'

/** The structured view of `schema.md`. */
export interface SchemaForm {
  readonly conflictBehavior: ConflictBehavior
  readonly rawImmutability: boolean
  readonly pageTypes: readonly string[]
  readonly namingConvention: string
}

/** Schema written into a brand-new library. */
export const DEFAULT_SCHEMA = `# LLM Wiki Schema

## 页面类型
- source
- entity
- concept
- comparison
- synthesis

## 页面结构
每个 Wiki 页面必须包含 YAML frontmatter：
---
title: 页面标题
type: entity | concept | source | comparison | synthesis
updated: YYYY-MM-DD
source: raw/对应文件路径
---

## 冲突处理规则
- 冲突行为：mark
- 标记格式：> ⚠️ **潜在冲突**
- 标记必须包含：冲突条款引用、冲突类型、建议处理方式

## 命名约定
- 实体页：entities/<名称>.md
- 概念页：concepts/<术语>.md
- 来源页：sources/<raw 相对目录>/<原始文件名>.md

## 不可变性规则
- raw/ 目录只读：是
`

/** Page-type fallback for a schema that declares none. */
const DEFAULT_PAGE_TYPES: readonly string[] = ['source', 'entity', 'concept']

/**
 * Read `schema.md` into a {@link SchemaForm}.
 * @param content - Raw Markdown.
 * @returns The structured view, defaulted where the document is silent.
 */
export function parseSchema(content: string): SchemaForm {
  const behavior = /冲突行为[：:]\s*(\w+)/.exec(content)?.[1] ?? 'mark'
  const typeSection = /##\s*页面类型\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(content)?.[1] ?? ''
  const types = [...typeSection.matchAll(/^[-*]\s+([\w-]+)/gm)].map(match => match[1] ?? '')
  return {
    conflictBehavior: behavior === 'reject' || behavior === 'overwrite' ? behavior : 'mark',
    rawImmutability: /raw\/\s*目录只读[：:]\s*是/.test(content),
    pageTypes: types.length > 0 ? types : DEFAULT_PAGE_TYPES,
    namingConvention: /实体页[：:]\s*(\S+)/.exec(content)?.[1] ?? 'entities/<名称>.md',
  }
}

/**
 * Rewrite `schema.md` from a form, preserving prose the form does not model.
 * @param original - Current Markdown.
 * @param form - Fields to write back.
 * @returns The merged document.
 */
export function mergeSchema(original: string, form: SchemaForm): string {
  let out = original === '' ? DEFAULT_SCHEMA : original
  out = withLine(
    out,
    /冲突行为[：:]\s*\w+/,
    `- 冲突行为：${form.conflictBehavior}`,
    '冲突处理规则',
    `- 冲突行为：${form.conflictBehavior}`,
  )
  out = withLine(
    out,
    /- raw\/\s*目录只读[：:]\s*\S+/,
    `- raw/ 目录只读：${form.rawImmutability ? '是' : '否'}`,
    '不可变性规则',
    `- raw/ 目录只读：${form.rawImmutability ? '是' : '否'}`,
  )
  if (/##\s*页面类型/.test(out)) {
    out = out.replace(
      /##\s*页面类型[\s\S]*?(?=\n##\s|\s*$)/,
      `## 页面类型\n${form.pageTypes.map(type => `- ${type}`).join('\n')}\n`,
    )
  }
  if (/##\s*命名约定/.test(out)) {
    out = out.replace(
      /##\s*命名约定[\s\S]*?(?=\n##\s|\s*$)/,
      `## 命名约定\n- 实体页：${form.namingConvention}\n`,
    )
  }
  return out
}

/**
 * Render a schema document from scratch.
 * @param form - Fields to render.
 * @returns A complete `schema.md`.
 */
export function renderSchema(form: SchemaForm): string {
  return [
    '# LLM Wiki Schema',
    '',
    '## 页面类型',
    ...form.pageTypes.map(type => `- ${type}`),
    '',
    '## 冲突处理规则',
    `- 冲突行为：${form.conflictBehavior}`,
    '',
    '## 命名约定',
    `- 实体页：${form.namingConvention}`,
    '',
    '## 不可变性规则',
    `- raw/ 目录只读：${form.rawImmutability ? '是' : '否'}`,
    '',
  ].join('\n')
}

/** Replace a matching line, or append the section that owns it when the line is absent. */
function withLine(
  document: string,
  pattern: RegExp,
  replacement: string,
  heading: string,
  line: string,
): string {
  if (pattern.test(document)) return document.replace(pattern, replacement)
  return `${document.replace(/\s+$/, '')}\n\n## ${heading}\n${line}\n`
}
