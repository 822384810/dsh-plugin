/**
 * Host half: the knowledge base itself.
 *
 * It registers the model-facing tools, the slash commands, the system-prompt knowledge
 * section, and the authenticated `/wiki` RPC channel the browser half reads. Nothing here is
 * reachable from the page without going through Connection's trust fence, which is why the
 * RPC channel is used instead of self-registering web routes.
 * @module llm-wiki
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dshHomePath } from './shared/home.ts'
import type {
  Agent,
  AgentDefaultModelService,
  CommandResult,
  LlmService,
  PluginContext,
  ToolDefinition,
} from './types.ts'
import type { Config, Settings } from './config.ts'
import { resolveSettings } from './config.ts'
import { LibraryRegistry } from './features/registry.ts'
import { Embedder } from './features/embedder.ts'
import { IngestQueue, type IngestOutcome } from './features/queue.ts'
import { AmbientRecall } from './features/recall.ts'
import { startWatcher } from './features/watcher.ts'
import { WikiService } from './service.ts'
import { ModelDirectory } from './features/models.ts'
import { createLogger, type Logger } from '@dsh-plugins-xz/log-utils'
import type { SchemaForm } from './shared/schema.ts'
import { ResultCode, reply } from '@dsh-plugins-xz/result-utils'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'llm-wiki'

/** Only the tool registry is required: every other face attaches when it exists. */
export const inject = ['tools']

/**
 * Minimum host release this build supports. Injected at build time from the
 * `@deepseek-ai/dsh` peer floor in `package.json`, which keeps one source of truth.
 */
export const MINIMUM_HOST_VERSION = __MINIMUM_HOST_VERSION__

/** Fetch route owned by this plugin, below Connection's authenticated `/api`. */
const ROUTE_PATH = '/api/llm-wiki'

/** System-prompt section this plugin owns. */
const PROMPT_SECTION = 'llm-wiki:knowledge'

/** Order placing the knowledge block after the harness's tool guidance. */
const PROMPT_ORDER = 50

/** The slice of Connection's Host Fetch-route registry this plugin registers on. */
interface FetchHost {
  readonly fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Arguments a tool receives, after the registry has validated them. */
type ToolArgs = Readonly<Record<string, unknown>>

/** Read one tool argument as a string. */
function str(args: ToolArgs, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

/** Read one tool argument as a number, falling back to a default. */
function num(args: ToolArgs, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Build a tool whose output is one text block.
 * @param options - Name, description, JSON-Schema parameters and the body.
 * @returns The definition `ctx.tools.register` accepts.
 */
function tool(options: {
  name: string
  description: string
  properties: Record<string, unknown>
  required?: readonly string[]
  run: (args: ToolArgs) => Promise<string>
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: options.properties,
      ...(options.required === undefined ? {} : { required: [...options.required] }),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return await options.run((args ?? {}) as ToolArgs)
    },
  }
}

/** Numeric release line of a version, or undefined when it is not `major.minor.patch`. */
function releaseLine(version: string): readonly [number, number, number] | undefined {
  const core = version.split('-', 1)[0] ?? ''
  const parts = core.split('.').map(part => Number(part))
  const [major, minor, patch] = parts
  if (parts.length < 3 || major === undefined || minor === undefined || patch === undefined) return undefined
  if (![major, minor, patch].every(part => Number.isInteger(part) && part >= 0)) return undefined
  return [major, minor, patch]
}

/** Compare two release lines; negative when `left` precedes `right`. */
function compareReleases(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2])
}

/**
 * Read the host platform's version, or undefined when this installation exposes it nowhere.
 *
 * The CLI package `@deepseek-ai/dsh` is the launcher and is intentionally not exposed to
 * plugins, so it cannot be resolved from here. The host-platform package this plugin actually
 * depends on — `@deepseek-ai/dsh-home-paths` — is always resolvable from a loaded plugin, and
 * its release line tracks the host it ships with (the minimum floor is derived from the
 * `@deepseek-ai/dsh` peer range). Probe that instead.
 */
function hostVersion(): string | undefined {
  const probes = [
    (): string => createRequire(import.meta.url).resolve('@deepseek-ai/dsh-home-paths/package.json'),
    (): string => dshHomePath('profiles', 'node_modules', '@deepseek-ai', 'dsh-home-paths', 'package.json'),
  ]
  for (const probe of probes) {
    try {
      const manifest = JSON.parse(readFileSync(probe(), 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // Probe miss: try the next location rather than failing the whole activation.
    }
  }
  return undefined
}

/**
 * Refuse to activate on a host older than the supported floor.
 *
 * The floor is primarily enforced by the plugin's `peerDependencies`, which the host checks
 * at load time. This runtime probe is a best-effort second line of defense: it compares the
 * installed host-platform package against the injected {@link MINIMUM_HOST_VERSION} when that
 * package is resolvable, and otherwise defers to the peer-dependency check rather than failing
 * activation on an unreadable version.
 *
 * @throws when the host reports a release line older than the supported floor.
 */
function assertHostVersion(): void {
  const actual = hostVersion()
  if (actual === undefined) return
  const host = releaseLine(actual)
  const floor = releaseLine(MINIMUM_HOST_VERSION)
  if (host === undefined || floor === undefined || compareReleases(host, floor) >= 0) return
  throw new Error(
    `${name}: host dsh ${actual} is older than the supported ${MINIMUM_HOST_VERSION}; `
    + 'upgrade the host, or install a plugin build for that host',
  )
}

/** Characters of a prompt kept as the recall query; a long prompt asks its question at the end. */
const RECALL_QUERY_CHARS = 400

/** Sessions whose newest prompt is remembered before the oldest entry is dropped. */
const RECALL_SESSIONS = 64

/**
 * The prompt text of one `user/message` session event.
 *
 * Only a message whose source is `user` counts: the harness appends goal and plugin messages to the
 * same stream, so accepting any of them would let the knowledge section recall against its own
 * output. Content is a block array in the harness's representation, of which only text is read.
 * @param data - The event's payload.
 * @returns The prompt text, or `''` when this event is not a human prompt.
 */
function userMessageText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as { source?: { kind?: unknown }; content?: unknown }
  if (record.source?.kind !== 'user') return ''
  if (typeof record.content === 'string') return record.content.slice(-RECALL_QUERY_CHARS)
  if (!Array.isArray(record.content)) return ''
  const text = record.content
    .filter(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
    .map(part => String((part as { text?: unknown }).text ?? ''))
    .join('\n')
  return text.slice(-RECALL_QUERY_CHARS)
}

/**
 * Follow each session's newest human prompt.
 *
 * The knowledge section is assembled before the model speaks, so the query cannot be taken from the
 * conversation's messages — the session's event stream is where the user's own text is. Entries are
 * capped because a long-lived process accumulates one per conversation; re-inserting a key keeps the
 * map in recency order, so the oldest falls out first.
 * @param ctx - Host context.
 * @returns A reader for the newest prompt of a session, `''` when none was seen.
 */
function watchPrompts(ctx: PluginContext): (sessionId: string) => string {
  const latest = new Map<string, string>()
  ctx.on('session/event', (session: unknown, event: unknown) => {
    if (typeof event !== 'object' || event === null) return
    if ((event as { type?: unknown }).type !== 'user/message') return
    const id = (session as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    const text = userMessageText((event as { data?: unknown }).data)
    if (text === '') return
    latest.delete(id)
    latest.set(id, text)
    while (latest.size > RECALL_SESSIONS) {
      const oldest = latest.keys().next().value
      if (oldest === undefined) break
      latest.delete(oldest)
    }
  }, { global: true })
  return id => latest.get(id) ?? ''
}

/**
 * Register everything the Host half owns.
 * @param ctx - Host context carrying the tool registry.
 * @param config - Settings from the bundle patch.
 */
export function apply(ctx: PluginContext, config: Config = {}): void {
  assertHostVersion()
  const settings = resolveSettings(config)
  const log: Logger = createLogger(name, { sink: ctx.logger })

  const registry = new LibraryRegistry(settings.registryPath, {
    chunkSize: settings.chunkSize,
    chunkOverlap: settings.chunkOverlap,
    topK: settings.topK,
    watch: settings.watch,
  }, log)
  const embedder = new Embedder()
  const models = new ModelDirectory()
  const ambient = new AmbientRecall(
    (query, topK) => service.retrieveLexical(registry.getActive()?.id ?? '', query, topK),
    { topK: settings.ambientTopK, maxChars: settings.ambientMaxChars },
  )
  const queue: IngestQueue = new IngestQueue({
    registry,
    settings,
    log,
    materialize: async (library, rel, text): Promise<number> =>
      await service.materializeMirror(library, rel, text),
    compile: async (library, sourceRelPath, text, indicators): Promise<IngestOutcome> =>
      await service.compile(library, sourceRelPath, text, indicators),
  })
  const service: WikiService = new WikiService({ registry, embedder, queue, settings, log, ambient, models })

  ctx.effect(() => () => { registry.closeAll() }, `${name}: close stores`)

  // Initialization is asynchronous, and `apply` cannot await without blocking activation, so
  // libraries appear a moment after start-up; until then the tools report an empty set.
  void (async () => {
    await embedder.init(settings.embeddingModelPath, settings.embeddingVocabPath, settings.embeddingDim)
    if (embedder.ready) {
      log.info(`embedder ready: path=${settings.embeddingModelPath || '(none)'} dim=${embedder.dim}`)
    } else {
      log.warn(`embedder not ready: path=${settings.embeddingModelPath || '(none)'} reason=${embedder.reason}`)
    }
    await registry.load()
    for (const seed of settings.libraries) {
      await registry.add({ name: seed.name ?? '', rootDir: seed.rootDir }).catch(error => {
        log.error(`seed library ${seed.rootDir} failed: ${String(error)}`)
      })
    }
    // Carry over per-file status written before the queue had its own document, so already indexed
    // libraries keep showing their state instead of looking untouched.
    const imported = service.migrateLegacyIngestStatus()
    if (imported > 0) log.info(`imported ${String(imported)} legacy ingest status record(s)`)
    // A file left `running` belongs to a process that is gone; anything still `queued` is resumed,
    // because the queue itself lives on disk and survives the restart.
    const recovered = service.recoverInterrupted()
    if (recovered > 0) log.warn(`recovered ${String(recovered)} interrupted ingest job(s)`)
    const resumed = queue.resumeAll()
    if (resumed > 0) log.info(`resuming ingest for ${String(resumed)} librar${resumed === 1 ? 'y' : 'ies'}`)
    if (settings.watch) await startWatchers(ctx, registry, queue, log)
  })().catch(error => log.error(`initialization failed: ${String(error)}`))

  registerTools(ctx, service)
  registerCommands(ctx, service)
  registerPromptSection(ctx, service, registry)
  registerRpc(ctx, service, queue, log)
  registerLlm(ctx, models, settings, log)
}

/** Register the model-facing tools. */
function registerTools(ctx: PluginContext, service: WikiService): void {
  const tools: ToolDefinition[] = [
    tool({
      name: 'wiki_library_list',
      description: '列出所有已注册的知识库及其是否处于活跃状态。',
      properties: {},
      run: async () => JSON.stringify(service.listLibraries(), undefined, 2),
    }),
    tool({
      name: 'wiki_library_add',
      description: '添加一个知识库：指定名称与根目录（该目录下会自动建立 raw/ 与 wiki/）。'
        + '用户说"新建知识库"或"把某个目录作为知识库"时调用。',
      properties: {
        name: { type: 'string', description: '知识库名称' },
        rootDir: { type: 'string', description: '知识库根目录的绝对路径' },
      },
      required: ['name', 'rootDir'],
      run: async args => {
        const library = await service.addLibrary(str(args, 'name'), str(args, 'rootDir'))
        return `已添加知识库「${library.name}」(${library.id})，根目录 ${library.rootDir}`
      },
    }),
    tool({
      name: 'wiki_library_switch',
      description: '切换当前活跃的知识库。',
      properties: { libId: { type: 'string', description: '知识库 ID' } },
      required: ['libId'],
      run: async args => `已切换到知识库「${await service.switchLibrary(str(args, 'libId'))}」`,
    }),
    tool({
      name: 'wiki_library_remove',
      description: '从注册表移除知识库（只移除登记，不删除磁盘文件）。',
      properties: { libId: { type: 'string', description: '知识库 ID' } },
      required: ['libId'],
      run: async args => {
        await service.removeLibrary(str(args, 'libId'))
        return `已移除知识库 ${str(args, 'libId')}`
      },
    }),
    tool({
      name: 'wiki_fs_upload',
      description: '上传文件到知识库的 raw/ 目录并自动触发摄入（解析→分块→索引→编译 Wiki）。'
        + '支持 PDF / DOCX / HTML / Markdown / 文本。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        fileName: { type: 'string', description: '文件名' },
        base64: { type: 'string', description: '文件内容的 base64 编码' },
        dir: { type: 'string', description: '可选：raw/ 下的目标子目录（POSIX 路径，省略则上传到根目录）' },
      },
      required: ['fileName', 'base64'],
      run: async args => {
        const outcome = await service.upload(str(args, 'libId'), str(args, 'fileName'), str(args, 'base64'), str(args, 'dir'))
        switch (outcome.status) {
          case 'created': return `已上传：${outcome.rel}`
          case 'duplicate': return `文件内容未变化，已跳过（已存在）：${outcome.rel}`
          case 'renamed': return `raw/ 下已存在同名但内容不同的文件，已自动重命名为 ${outcome.renamedTo}（现共两个文件）`
        }
      },
    }),
    tool({
      name: 'wiki_fs_mkdir',
      description: '在知识库的 raw/ 下新建目录（支持多级，用 / 分隔）。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        dir: { type: 'string', description: '要创建的目录相对路径，如 raw/foo/bar' },
      },
      required: ['dir'],
      run: async args => {
        await service.makeDir(str(args, 'libId'), str(args, 'dir'))
        return `已创建目录：${str(args, 'dir')}`
      },
    }),
    tool({
      name: 'wiki_fs_delete',
      description: '删除知识库 raw/ 下的文件或目录（目录连同其下所有文件、含子目录）及其索引。此操作不可逆。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        path: { type: 'string', description: '相对路径：文件如 raw/xxx.pdf，目录如 raw/子目录' },
      },
      required: ['path'],
      run: async args => {
        const removed = await service.deleteFile(str(args, 'libId'), str(args, 'path'))
        return `已删除 ${String(removed)} 个文件：${str(args, 'path')}`
      },
    }),
    tool({
      name: 'wiki_fs_reingest',
      description: '重新解析并摄入指定文件或目录（目录含其下所有文件、含子目录），适用于内容更新或上次摄入失败的情况。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        path: { type: 'string', description: '相对路径：文件或目录' },
      },
      required: ['path'],
      run: async args => {
        const queued = await service.reingest(str(args, 'libId'), str(args, 'path'))
        return `已加入重新摄入队列 ${String(queued)} 个文件：${str(args, 'path')}`
      },
    }),
    tool({
      name: 'wiki_list_pages',
      description: '列出知识库中所有 Wiki 页面（路径、标题、类型、更新时间）。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => JSON.stringify(await service.listPages(str(args, 'libId')), undefined, 2),
    }),
    tool({
      name: 'wiki_search',
      description: [
        '从知识库中检索与问题相关的原文片段与 Wiki 页面。',
        '当用户询问标准条款、技术指标、术语定义等内容时，优先调用此工具。',
        '检索对多个关键词是「或（OR）」关系：用空格分隔多个关键词（如「数据元 定义 标识」）即可匹配包含任一关键词的片段，比整句提问召回更全；',
        '若一次提问覆盖多个无关主题，可并行发起多次调用，每次聚焦一个主题。',
        '返回结果包含原文片段、来源文件路径与相关性分数；',
        '若结果不足以回答问题，应如实告知用户，不要编造。',
      ].join(' '),
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        query: { type: 'string', description: '检索词：可用空格分隔多个关键词做 OR 检索（如「数据元 标识 表示」），比整句提问召回更全' },
        topK: { type: 'number', description: '返回条数，默认 8' },
      },
      required: ['query'],
      run: async args => {
        const query = str(args, 'query')
        const hits = await service.search(str(args, 'libId'), query, num(args, 'topK', 8))
        if (hits.length === 0) return JSON.stringify({ found: false, message: '知识库中未找到相关内容' })
        return JSON.stringify({
          found: true,
          results: hits.map(hit => ({
            content: hit.content,
            score: Number(hit.score.toFixed(4)),
            source: hit.sourcePath,
          })),
        }, undefined, 2)
      },
    }),
    tool({
      name: 'wiki_recompile',
      description: '根据某个 Wiki 页面对应的 raw 来源重新编译该页面。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        path: { type: 'string', description: 'Wiki 页面相对 wiki/ 的路径' },
      },
      required: ['path'],
      run: async args => {
        const result = await service.recompile(str(args, 'libId'), str(args, 'path'))
        return `已重新编译：新建 ${result.created.length} 页，更新 ${result.updated.length} 页，冲突 ${String(result.conflicts)} 处`
      },
    }),
    tool({
      name: 'wiki_reindex',
      description: '清空知识页面（entities/、concepts/）、全部来源镜像、索引与元数据后，重新摄入 raw/ 下所有文件（含 LLM 重新编译）。耗时较长，且不可逆。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => `已清空并重建：提交 ${String(await service.reindex(str(args, 'libId')))} 个文件`,
    }),
    tool({
      name: 'wiki_recompile_all',
      description: '从 sources/ 来源镜像出发，保留原始材料与来源镜像，仅清空并重新编译全部实体/概念页面及其检索索引（会重新调用模型，可能耗时并消耗 token）。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => `已开始全部重新编译：共 ${String(await service.recompileAll(str(args, 'libId')))} 个来源`,
    }),
    tool({
      name: 'wiki_conflicts',
      description: '列出知识库中所有被标记的潜在冲突。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => await service.conflictReport(str(args, 'libId')),
    }),
    tool({
      name: 'wiki_lint',
      description: '对知识库做健康检查：缺失 frontmatter、断链等。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => await service.lint(str(args, 'libId')),
    }),
    tool({
      name: 'wiki_stats',
      description: '查看知识库统计：分块数、来源数、指标数、页面数、向量数、存储后端。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => JSON.stringify(await service.stats(str(args, 'libId')), undefined, 2),
    }),
    tool({
      name: 'wiki_schema_get',
      description: '读取当前知识库的维护规则（schema.md）。',
      properties: { libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' } },
      run: async args => await service.schemaGet(str(args, 'libId')),
    }),
    tool({
      name: 'wiki_schema_update',
      description: '更新知识库的维护规则：冲突处理行为、页面类型、raw 只读、命名约定。',
      properties: {
        libId: { type: 'string', description: '知识库 ID，省略则使用活跃库' },
        conflictBehavior: { type: 'string', enum: ['mark', 'reject', 'overwrite'], description: '冲突处理行为' },
        rawImmutability: { type: 'boolean', description: 'raw/ 目录是否只读' },
        pageTypes: { type: 'array', items: { type: 'string' }, description: '允许的页面类型' },
        namingConvention: { type: 'string', description: '实体页命名约定' },
      },
      run: async args => {
        const current = await service.schemaParse(str(args, 'libId'))
        const form: SchemaForm = {
          conflictBehavior: typeof args['conflictBehavior'] === 'string'
            ? (args['conflictBehavior'] as SchemaForm['conflictBehavior'])
            : current.conflictBehavior,
          rawImmutability: typeof args['rawImmutability'] === 'boolean' ? args['rawImmutability'] : current.rawImmutability,
          pageTypes: Array.isArray(args['pageTypes'])
            ? args['pageTypes'].filter((item): item is string => typeof item === 'string')
            : current.pageTypes,
          namingConvention: str(args, 'namingConvention') === '' ? current.namingConvention : str(args, 'namingConvention'),
        }
        await service.schemaUpdate(str(args, 'libId'), form)
        return 'Schema 已更新'
      },
    }),
  ]

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }
}

/** Register the slash commands. */
function registerCommands(ctx: PluginContext, service: WikiService): void {
  const maybe = ctx.inject(['commands'], commandsCtx => {
    const commands = commandsCtx.commands as { register(definition: {
      name: string
      description: string
      input?: { hint: string }
      handler: (invocation: { rawInput: string }) => CommandResult | Promise<CommandResult>
    }): () => void }

    const success = (text: string): CommandResult => ({ kind: 'success', text })
    const failure = (text: string): CommandResult => ({ kind: 'error', text })

    commandsCtx.effect(() => commands.register({
      name: 'wiki-query',
      description: '在知识库中检索相关内容',
      input: { hint: '<你的问题>' },
      handler: async invocation => {
        const query = invocation.rawInput.trim()
        if (query === '') return failure('请提供查询内容')
        const hits = await service.search('', query, 8).catch(error => {
          throw new Error(String(error))
        })
        if (hits.length === 0) return success('知识库中未找到相关内容。')
        return success(hits.map((hit, index) => (
          `[${String(index + 1)}] 来源：${hit.sourcePath}\n${hit.content.slice(0, 400)}`
        )).join('\n\n---\n\n'))
      },
    }), 'llm-wiki: /wiki-query')

    commandsCtx.effect(() => commands.register({
      name: 'wiki-conflicts',
      description: '列出当前知识库中所有标记的潜在冲突',
      handler: async () => success(await service.conflictReport('')),
    }), 'llm-wiki: /wiki-conflicts')

    commandsCtx.effect(() => commands.register({
      name: 'wiki-lint',
      description: '对知识库做健康检查',
      handler: async () => success(await service.lint('')),
    }), 'llm-wiki: /wiki-lint')

    commandsCtx.effect(() => commands.register({
      name: 'wiki-reindex',
      description: '重建当前知识库（清空 Wiki 页面与索引后重新摄入 raw/）',
      handler: async () => success(`已清空并重建：提交 ${String(await service.reindex(''))} 个文件`),
    }), 'llm-wiki: /wiki-reindex')
  })
  void maybe
}

/**
 * Add the knowledge section to every agent's system prompt.
 *
 * Registered through the agent's own context, which is how the shipped persona plugin does it: the
 * agent owns the section's lifetime, so it disappears with that agent instead of reaching every
 * prompt in the process — and the section is not collected here, because disposing the agent's
 * context disposes it. `ctx.session` is not an option: `session` is a property of the Agent, not a
 * host service, and an undeclared read throws `cannot get property "session" without inject` while
 * the prompt is being assembled — which fails the user's turn, not the plugin's load. The query is
 * taken from the session's own event stream instead.
 * @param ctx - Host context.
 * @param service - Knowledge-base service.
 * @param registry - Library registry, read for the active knowledge base.
 */
function registerPromptSection(
  ctx: PluginContext,
  service: WikiService,
  registry: LibraryRegistry,
): void {
  const promptOf = watchPrompts(ctx)
  ctx.on('agent/created', (payload?: unknown) => {
    const agent = (payload as { agent?: Agent } | null)?.agent
    const systemPrompt = agent?.ctx?.systemPrompt
    if (agent === undefined || systemPrompt === undefined) return
    systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      // A section's text is read while the host assembles a prompt, so an error here would fail the
      // user's turn; anything unexpected degrades to no section instead.
      text: () => {
        try {
          const active = registry.getActive()
          if (active === null) return ''
          const recalled = service.ambientContext(promptOf(agent.session.id))
          const guidance = `当前知识库「${active.name}」。回答涉及该知识库内容的问题时，`
            + '先调用 wiki_search 检索原文再作答；检索不到就如实说明，不要凭记忆编造。'
          return recalled === '' ? guidance : `${recalled}\n\n${guidance}`
        } catch {
          return ''
        }
      },
    })
  })
}

/**
 * Serve the browser half over Connection's authenticated Fetch channel.
 *
 * The route lives on the shared `/api` channel, so the Host/Origin fence and the browser
 * session cookie apply unchanged. `connection.rpc.handle` was the first carrier, but the
 * harness resolves the `webServer` service behind it against the registering context's fiber,
 * which an out-of-tree plugin cannot satisfy, so the channel never mounted.
 * @param ctx - Host context.
 * @param service - Knowledge-base service.
 * @param queue - Ingest queue backing `ingest_state`.
 * @param log - Diagnostics sink.
 */
function registerRpc(
  ctx: PluginContext,
  service: WikiService,
  queue: IngestQueue,
  log: Logger,
): void {
  const maybe = ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.connection as FetchHost
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => await handleRoute(request, service, queue, log),
    }), `${name}: POST ${ROUTE_PATH}`)
  })
  void maybe
}

/**
 * One browser request: `{ endpoint, args }` in, the shared `{ code, msg, data }` envelope out.
 * @param request - Buffered Fetch request.
 * @param service - Knowledge-base service.
 * @param queue - Ingest queue.
 * @param log - Diagnostics sink.
 * @returns The JSON response.
 */
async function handleRoute(
  request: Request,
  service: WikiService,
  queue: IngestQueue,
  log: Logger,
): Promise<Response> {
  let body: { endpoint?: unknown; args?: unknown }
  try {
    body = await request.json() as typeof body
  } catch {
    return reply(ResultCode.PARAM_ERR, 'body is not JSON')
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const args = (body.args ?? {}) as ToolArgs
  try {
    return reply(ResultCode.OK, 'ok', await dispatch(service, queue, endpoint, args))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`wiki ${endpoint} failed: ${message}`)
    return reply(ResultCode.EXCEPTION, message)
  }
}

/** One browser endpoint. */
async function dispatch(
  service: WikiService,
  _queue: IngestQueue,
  endpoint: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (endpoint) {
    case 'library_list': return service.listLibraries()
    case 'library_add': return await service.addLibrary(str(args, 'name'), str(args, 'rootDir'))
    case 'library_rename': return await service.renameLibrary(str(args, 'libId'), str(args, 'name'))
    case 'library_switch': return { ok: true, name: await service.switchLibrary(str(args, 'libId')) }
    case 'library_remove':
      await service.removeLibrary(str(args, 'libId'))
      return { ok: true }

    case 'fs_list': return await service.listDir(str(args, 'libId'), str(args, 'path'))
    case 'fs_read': return await service.readFile(str(args, 'libId'), str(args, 'path'))
    case 'fs_download': return await service.downloadFile(str(args, 'libId'), str(args, 'path'))
    case 'fs_preview': return await service.previewFile(str(args, 'libId'), str(args, 'path'))
    case 'fs_write':
      await service.writeFile(str(args, 'libId'), str(args, 'path'), str(args, 'content'))
      return { ok: true }
    case 'fs_upload': return await service.upload(str(args, 'libId'), str(args, 'fileName'), str(args, 'base64'), str(args, 'dir'))
    case 'fs_mkdir':
      await service.makeDir(str(args, 'libId'), str(args, 'dir'))
      return { ok: true }
    case 'fs_delete':
      return { removed: await service.deleteFile(str(args, 'libId'), str(args, 'path')) }
    case 'fs_reingest':
      return { queued: await service.reingest(str(args, 'libId'), str(args, 'path')) }

    case 'list_pages': return await service.listPages(str(args, 'libId'))
    case 'search': return await service.search(str(args, 'libId'), str(args, 'query'), num(args, 'topK', 8))
    case 'recompile': return await service.recompile(str(args, 'libId'), str(args, 'path'))
    case 'reindex': return { queued: await service.reindex(str(args, 'libId')) }
    case 'recompile_all': return { queued: await service.recompileAll(str(args, 'libId')) }
    case 'conflicts': return await service.conflicts(str(args, 'libId'))
    case 'lint': return { report: await service.lint(str(args, 'libId')) }
    case 'source_detail': return await service.sourceDetail(str(args, 'libId'), str(args, 'sourcePath'))
    case 'stats': return await service.stats(str(args, 'libId'))

    case 'supported_types': return service.supportedTypes()
    case 'model_catalog': return await service.modelCatalog(str(args, 'libId'))
    case 'model_set':
      await service.setCompileModel(str(args, 'libId'), str(args, 'provider'), str(args, 'model'))
      return { ok: true }

    case 'schema_get': return { content: await service.schemaGet(str(args, 'libId')) }
    case 'schema_parse': return await service.schemaParse(str(args, 'libId'))
    case 'schema_update':
      return { content: await service.schemaUpdate(str(args, 'libId'), args['form'] as SchemaForm) }

    case 'ingest_state': return service.ingestStates(str(args, 'libId'))
    default: throw new Error(`unknown endpoint: ${endpoint}`)
  }
}

/**
 * Wire the model runtime and the deployment default into the compiler.
 *
 * Both services are optional. Without `llm` there is nothing to stream with; without
 * `agentDefaultModel` a library that neither picked a model nor inherited a configured route has
 * no route at all. Either way the compiler falls back to its deterministic page rather than
 * failing activation.
 * @param ctx - Host context.
 * @param models - Model directory to attach the services to.
 * @param settings - Settings from the bundle patch.
 * @param log - Diagnostics sink.
 */
function registerLlm(ctx: PluginContext, models: ModelDirectory, settings: Settings, log: Logger): void {
  const runtime = ctx.inject(['llm'], llmCtx => models.attachLlm(llmCtx.llm as LlmService))
  const defaults = ctx.inject(['agentDefaultModel'], defaultCtx =>
    models.attachDefaults(defaultCtx.agentDefaultModel as AgentDefaultModelService))
  void runtime
  void defaults
  if (settings.compileProvider === '' || settings.compileModel === '') {
    log.info('no compileProvider/compileModel configured; each library compiles with its own choice or the deployment default model')
  }
}

/** Watch every library that asked for it. */
async function startWatchers(
  ctx: PluginContext,
  registry: LibraryRegistry,
  queue: IngestQueue,
  log: Logger,
): Promise<void> {
  for (const library of registry.list()) {
    const runtime = registry.get(library.id)
    if (runtime === undefined || !runtime.watch) continue
    const stop = await startWatcher(runtime.rawDir, filePath => queue.enqueue(filePath, runtime.id))
    ctx.effect(() => stop, `${name}: watch ${runtime.id}`)
  }
  log.info(`watching ${String(registry.list().length)} library director${registry.list().length === 1 ? 'y' : 'ies'}`)
}
