# @dsh-plugins-xz/llm-wiki

知识库插件：把一批原始文档变成一个**由 LLM 维护的 Wiki**，并在对话里按需要召回。

**核心特性：**
- **原始文档摄入**：上传 / 删除 / 重新摄入 `raw/` 下的源文件，源文件只读、作为唯一真源。
- **LLM 编译 Wiki**：解析 → 分块 → 建索引 → 数值宽严预检 → 编译成结构化知识（概念页 / 实体页 / 来源页 + `index.md` / `log.md`）。
- **Schema 驱动维护**：通过 `wiki/schema.md` 告诉 LLM 怎么维护 Wiki，面板表单或对话都能调整。
- **对话内召回**：在对话中按需要召回 Wiki 知识，辅助回答。

三层结构（Karpathy 分层）：

| 层 | 位置 | 可变性 | 作用 |
|:---|:---|:---|:---|
| **Raw Sources** | `<库>/raw/` | **只读**：只能上传 / 删除 / 重新摄入，不能编辑 | 原始文档，source of truth |
| **Wiki** | `<库>/wiki/{entities,concepts,sources}/` | 可写：可在面板里改，可重新编译 | LLM 编译出的结构化知识 |
| **Schema** | `<库>/wiki/schema.md` | 可调：面板表单或对话都能改 | 告诉 LLM 怎么维护 Wiki |

一个来源进入后不是只生成一份摘要：编译会更新概念页、新建实体页、标记冲突，并刷新 `index.md` / `log.md`。

## 两面

| | Host 面（Node） | Client 面（浏览器） |
|:---|:---|:---|
| 产物 | `lib/index.js` | `lib/client.js` |
| 提供 | 16 个 Agent 工具、4 个斜杠命令、system prompt 知识段、`/wiki` RPC | 侧边栏「知识库」面板：原始材料 / 知识页面 / 维护规则 三个标签页 |

## 装到 profile

```powershell
cd <dsh-plugin>\plugins\llm-wiki
pnpm run build
pnpm pack --pack-destination ..\..\..\dist

cd <harness>
pnpm dsh --profile wiki-dev --from-default-profile web --dump-config
pnpm dsh plugin --profile wiki-dev add <dsh-plugin>\dist\dsh-plugins-xz-llm-wiki-0.2.1.tgz
pnpm dsh --profile wiki-dev
```

`pnpm pack` 的 prepack 会提前下载/校验 PP-OCR、句向量与 Tesseract 语言库，随 tgz 一起打包；离线打包先在插件目录跑一次 `pnpm fetch-models`（语言库也可单独 `pnpm fetch-tessdata`）。

## 配置

写在 `cordis.patch.yml` 的插件条目 `config:` 下（默认值见 `src/config.ts`）：

| 字段 | 默认 | 说明 |
|:---|:---|:---|
| `libraries` | `[]` | 启动时自动注册的库：`[{ name, rootDir }]` |
| `registryPath` | `$DSH_HOME/storages/llm-wiki/registry.json` | 多库注册表位置 |
| `chunkSize` / `chunkOverlap` | `800` / `100` | 单块字数**上限**（含块首的章节定位行）与重叠；重叠必须小于分块大小 |
| `topK` | `5` | 混合检索返回条数（`wiki_search` 工具默认同值） |
| `watch` | `true` | 监听 `raw/` 自动摄入（需要 `chokidar`） |
| `embeddingModelPath` | 包内置 `models/embed/model.onnx` | ONNX 句向量模型（默认随包发布的 `bge-small-zh-v1.5`，512 维）；**置空或指向不存在的文件则退回字面检索** |
| `embeddingVocabPath` | 空 | `vocab.txt`，默认取模型同目录 |
| `embeddingDim` | `512` | 期望向量维度，与模型不符时拒绝加载 |
| `ocrEngine` | `auto` | 扫描/坏文本层 PDF 的 OCR 引擎：`ppocr` / `tesseract` / `auto`（默认即用**包内置的 PP-OCRv6 模型**，模型缺失才退回 Tesseract） |
| `ocrModelDir` | 空 | PP-OCR 模型目录覆盖：`det.onnx`、`rec.onnx`、`rec.dict.txt`，可选 `cls.onnx`；**留空用插件内置 `models/ppocr/`**（官方 PP-OCRv6 small 档），换目录即换档位/自定义模型 |
| `ocrRenderScale` | `3` | PP-OCR 路径的栅格化倍率，越高小字越清晰（上限 6）。默认 3，与 Tesseract 路径处理表格页的倍率一致——表格里字最小；开销随倍率**平方**增长，大字印刷件可下调到 2 |
| `ocrLanguages` | `chi_sim+eng` | 扫描版 PDF 的 OCR 语言（仅 Tesseract 兜底路径用到） |
| `ocrLangPath` | 空 | Tesseract 语言数据目录（或 URL）；留空依次查 `WIKI_OCR_LANG_PATH` 与插件自带 `tessdata/`（内置 `chi_sim`、`eng` 的 4.0.0 完整档，可离线）。目录里放 `.traineddata.gz` 或解压后的 `.traineddata` 都行，`gzip` 按目录内容自动探测 |
| `extraSourceExtensions` | `[]` | 追加为「纯文本源」的扩展名（可带或不带点，如 `rst`）。内置：`.md/.markdown/.txt/.json/.csv/.tsv/.yaml/.yml/.xml/.log/.ini/.cfg` 与 `.pdf/.docx/.html/.htm` |
| `ambientTopK` / `ambientMaxChars` | `5` / `4000` | 注入 system prompt 的召回片段数量与整体字符预算（每条最多 2000 字符，默认约 2 片完整、末条按剩余预算裁剪）；需要每轮给足 5 片时调回 `10000` |
| `compileProvider` / `compileModel` | 空 | 部署级兜底路由；留空时用「各知识库在面板里选的模型」，再退回 DSH 默认模型。没有可用模型时不提炼页面（不生成 `entities/`、`concepts/`），镜像与检索照常 |
| `compileWindowChars` / `compileMaxWindows` | `2000` / `200` | 常规每窗字数与单个来源的窗口数上限（窗口重叠 200 字符）。超过小窗覆盖量的大文件会**自动放大每窗到最多约 20200 字**，用 ≤200 次调用读完全文；总覆盖约 400 万字符，再超出的尾部才跳过并告警。单窗上限还会被上下文预算压低，小上下文模型需要调大 `compileMaxWindows` 补覆盖 |
| `compileMaxTokens` | `16384` | 单个窗口页面计划的**起步**输出预算；低于 `16384` 会抬回，且不会超过 `compileMaxOutputTokens` |
| `compileMaxOutputTokens` | `32768` | 输出中途截断（含 `max-tokens` 结束原因）时翻倍重试的**上限**，按模型实际输出能力配置；不低于 `16384`，且不超过 `compileContextTokens / 2`。**大文件放大后的窗口直接以该上限起步**；在上限处仍截断时不再用同一预算无效重试，而是把窗口拆成两个子窗、退回起步预算重新规划（最多两层） |
| `compileContextTokens` / `compileCharsPerToken` | `128000` / `1` | 模型上下文窗口（token）与字符→token 换算比。编译先预留「输出上限 + 约 12000 token 的 prompt 固定开销」，剩余才是正文窗口预算；发送前还会用**实际拼好的 prompt** 复核，超限则拆窗。默认 128k 不影响约 400 万字覆盖；32k 模型会自动缩小单窗以免溢出。中文按 1 字符≈1 token 保守估算，纯英文可调到 `3`~`4` |
| `maxUploadBytes` | `52428800` | 单文件上传上限 |
| `vectorApprox` | `true` | 大库（>512 个向量）先用随机投影草图筛出候选（含字面命中），再只对候选做精确余弦；置 `false` 则全量精确扫描。相同查询的向量 30 秒内复用；编译每 8 窗才做一次语义检索，其余窗口走字面检索 |

面板顶部知识库下拉之后有一个「模型」选择器：列出 DSH 已注册的 provider 与模型，默认显示该库当前编译所用的模型（本库选择 → 插件配置 → DSH 默认）。选择按知识库分别保存，只影响该库的编译。

### 数据流与检索

- **三层文件**：`raw/` 存上传原件（只读、不参与检索）；`wiki/sources/**` 是解析后的原文镜像（目录结构与 `raw/` 一致，二进制源唯一可读全文就在这里）；`entities/`、`concepts/` 是模型提炼的结构化知识。
- **镜像可改、重新入库覆盖**：保存镜像即重新入索引；「重新编译」以镜像正文为准重提炼（二进制源也能正确重编译），但「重新入库」会直接覆盖镜像、丢掉人工修改。
- **检索索引 = 镜像 + entities/concepts**：每份来源只有一份文本，命中镜像时 `sourcePath` 仍指向 `raw/` 原件。
- **分块带定位行**：按文档结构（空行 / 段落 / 表格块）切分，整块不超过 `chunkSize`，每块以 `[文档名·条款号·表题]` 开头，保证检索结果可读。
- **编译分窗、只写知识页**：长文件按 `compileWindowChars`（默认 2000 字，窗口重叠 200 字）切窗送模型再合并；超过 200 个小窗的大文件会**自动放大每窗（最多约 20200 字），用不超过 200 次调用读完全文**，总覆盖保持约 400 万字符，不再丢弃后半截（日志会记录放大后的窗口尺寸）；每窗带混合检索的相关片段，并只列最相关的 40 个已有页面，让 prompt 不随库规模膨胀。输出预算起步 16384，中途截断时翻倍（上限 `compileMaxOutputTokens`，默认 32768）重试；在上限处仍截断、或实际拼好的 prompt 按 `compileContextTokens` 复核放不下时，会自动把该窗拆成两个子窗、退回起步预算重新规划（最多两层），避免用同一预算无效重试。单窗口最多 3 次尝试，全败则跳过但镜像与索引照常写入。模型只写 `entities/`、`concepts/`（`sources/` 被提示词与代码双侧禁止）；同义 slug 的新建会在写前改写成 update 并合并。
- **解析保结构、扫描件 OCR**：docx / html / pdf 转 Markdown（标题、列表、表格、字体层级等）；无文本层，或文本层被判为乱码（私用区/替代字符、符号噪声，以及中文标准 PDF 常见的全角拉丁字母与数字指纹）时走 OCR，并重建表格几何、剔除页眉页脚重复行、去汉字间空格。pdf.js 的 WASM/CMAP 静态资源随包定位，JBIG2/JPEG2000 扫描页不会被画成空白。
- **扩展名白名单**：仅白名单类型入库，未知类型在解析 / 上传阶段即拦下；用 `extraSourceExtensions` 追加新类型。
- **时间口径**：日期取自 `@dsh-plugins-xz/time-utils`，呈现一律本机时区（`YYYY-MM-DD`）。
- **重建全清重来**：清空知识页、镜像、索引与 `meta.json` 后重处理全部 `raw`（不可逆，人工修改不恢复）。

### 编译诊断日志

把宿主日志级别开到 `debug`（日志里的 `[D]`）后，编译日志按「一次编译两行 + 每次调用两行」组织，完整诊断不重复打印：

- `[compile] source=... provider=... model=...`：本次**实际解析到的模型路由**。先确认这里是不是推理模型——思维链会吃掉 `maxTokens`、正文为空，表现得像输出被截断。
- `[compile-plan] windows=... windowChars=... atCeiling=... output=... context=...`：分窗结果与输出/上下文预算。
- `compile window X/N #n/3 max_tokens=...`：每次调用一行，首次额外带 `atCeiling / promptChars / canSplit`。
- `[llm] provider=... model=... maxTokens=... elapsedMs=... ...`：**每次模型流唯一的一行完整诊断**，成败都打。失败时的 `[W]` 告警只带简短摘要（`finish / code / elapsedMs / outputChars / outcome`）和 `hitCeiling` 判定，完整字段看这一行即可；翻倍、拆窗、到达上限等决策另有 `[W]` 说明。

| 字段 | 用途 |
|---|---|
| `elapsedMs` / `firstDeltaMs` | 区分「模型生成慢」与「首字前卡住 / 网关排队」；长流容易被中间代理掐断 |
| `promptChars` / `outputChars` | 区分「输出打满预算」与「思维链占满配额但正文为空」 |
| `chunks` | 各类 chunk 计数；出现 `reasoning-*` 类型说明是推理模型 |
| `finish` / `code` | `max-tokens` = 输出预算打满；`error` + `code=TRANSPORT` = 连接中途断开（如 `terminated`），与 token 无关 |
| `outcome` | `ok` / `error`（宿主 finish 报错）/ `throw`（流直接抛异常） |

## 依赖策略

核心能力零依赖：SQLite 用 Node 内置的 `node:sqlite`（含 FTS5，中文用 trigram 分词），没有就用 JSON 索引兜底。

以下能力**按需、可选**，装了才生效，没装只降级对应功能（不会让插件起不来）：

| 可选包 | 缺失时的表现 |
|:---|:---|
| `chokidar` | 不自动监听 `raw/`，仍可上传 / 重新摄入 / `/wiki-reindex` |
| `pdfjs-dist` | 无法解析 PDF |
| `mammoth` | 无法解析 DOCX |
| `iconv-lite` + `jschardet-ultra` | 非 UTF-8（GBK / Big5 等）文档退化为 UTF-8 解码 |
| `onnxruntime-node` + 模型文件 | 字面 + 向量混合检索（向量走包内置 `bge-small-zh-v1.5`，纯 CPU 计算） |
| `tesseract.js` | 扫描版 PDF 报"无文本层"而不 OCR（PP-OCR 缺失时的兜底引擎，见下文「扫描件 OCR」）；语言库随包放在 `tessdata/`（`chi_sim` + `eng` 的 4.0.0 完整档），可用 `ocrLangPath` / `WIKI_OCR_LANG_PATH` 覆盖 |

### 扫描件 OCR：PP-OCR（推荐）与 Tesseract（兜底）

扫描版/坏文本层 PDF 的识别质量，主要取决于 OCR 引擎。默认 `ocrEngine: auto`：

- **包内置模型在**（正常安装即如此）→ 用 **PP-OCRv6**（PaddleOCR 官方 ONNX，中文与中英混排明显优于 Tesseract），纯 CPU、走已有的 `onnxruntime-node`，**不需要任何外部软件**（无 Python / 无 PaddleOCR / 无系统 tesseract），零配置开箱即用。
- **模型缺失** → 自动退回 **Tesseract**（行为与旧版一致，零回归）。

**Tesseract 语言库**（仅兜底路径用到）：随包内置 `tessdata/chi_sim.traineddata.gz` 与 `eng.traineddata.gz`，与 harness 服务端的 `tessdata 4.0.0` 完整档同源（钉死 SHA-256），离线可用、两侧识别结果一致。定位优先级：`ocrLangPath` → `WIKI_OCR_LANG_PATH` → 包内 `tessdata/`；目录里放解压后的 `<lang>.traineddata` 会自动关掉 `gzip`，放 `.gz`（默认）则按 gzip 读取。显式配置也支持 URL，由 tesseract.js 自行下载。

> **Windows 前提**：PP-OCR 与向量检索同走 `onnxruntime-node`，其原生绑定要求 **VC++ 2015-2022 运行库 ≥ 14.25**（2020 年后随主流软件分发，多数机器已满足；系统自带的可能停留在 14.2x 之前）。运行库过旧时加载模型会在原生层直接崩溃——装最新版 [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe) 即可，无需改动插件或依赖版本。

### 模型从哪来：打包时自动下载，随 tgz 分发

PP-OCR、句向量模型与 Tesseract 语言库这些二进制资源**都不进 git**（仓库保持轻量），由打包脚本在 **`pnpm pack` 的 prepack 钩子里提前下载**并写入 `models/` 与 `tessdata/`，随 `files` 一起打进 tgz——用户 `pnpm add <tarball>` 安装时即得完整资源，无需任何手动操作、也无需联网。要提前下载，先在 `plugins/llm-wiki` 跑一次 `pnpm fetch-models`（含语言库）；`prepack` 会逐个校验，已存在且 SHA 正确就直接跳过，缺了才联网补。各资源的来源如下：

- **PP-OCR**：[`scripts/fetch-models.mjs`](scripts/fetch-models.mjs) 写入 `models/ppocr/`。下载源为官方 `PaddlePaddle/PP-OCRv6_*_onnx` HuggingFace 仓库（Apache-2.0，优先走 hf-mirror 镜像），**逐文件校验钉死的 SHA-256 与字节数**，字典从模型自带的 `inference.yml` 现场提取，保证与 rec 档位严格配套。默认 `small` 档（det 9.9MB + rec 21.2MB，tgz 约 +31MB）。
- **句向量（语义检索）**：[`scripts/fetch-embed-model.mjs`](scripts/fetch-embed-model.mjs) 写入 `models/embed/`（`model.onnx` + `vocab.txt`，默认 `BAAI/bge-small-zh-v1.5`，512 维，Apache-2.0，tgz 约 +130MB）。SHA-256 取该仓库的 LFS pointer 现场校验，不硬编码。默认即开箱启用向量检索；向量与字面召回经 RRF 融合，二者互补。
- **Tesseract 语言库**：[`scripts/fetch-tessdata.mjs`](scripts/fetch-tessdata.mjs) 写入 `tessdata/`（`chi_sim` + `eng`），下载源 `tessdata.projectnaptha.com/4.0.0`，**逐文件校验钉死的 SHA-256 与字节数**，与 harness 服务端保持一致；由 `prepack` 提前下载后随 tgz 分发，安装完即可离线兜底 OCR。

常用命令（在 `plugins/llm-wiki` 下）：

```bash
pnpm fetch-models                # 提前下载全部二进制资源：PP-OCR + 句向量 + 语言库（幂等）
pnpm fetch-tessdata              # 只校验 / 补一次 Tesseract 语言库（幂等）
node scripts/fetch-embed-model.mjs            # 仅补 embedding 模型
node scripts/fetch-models.mjs --tier medium   # 换档：复杂排版/低质量扫描件用 medium
node scripts/fetch-models.mjs --force         # 重新下载
```

手动摆放模型（或换用 v4/v5 旧版）只需要一个目录加 `ocrModelDir` 配置，文件名固定：

```
<某个目录>/
  det.onnx        # 文本检测（DB）
  rec.onnx        # 文本识别（CTC）
  rec.dict.txt    # rec 的字符字典（每行一个字符、不含 blank；须与 rec 档位配套）
  cls.onnx        # 可选：方向分类，自动纠正 180° 倒置行（v6 无独立 cls，可复用 v5/v2 方向分类模型）
```

档位选择（v6 三档）：

| 档位 | 参数量 | 建议 |
|---|---|---|
| `small` | 7.7M | **默认推荐**：本地 CPU 下速度/精度最均衡 |
| `medium` | 34.5M | 复杂排版、低质量扫描件；识别较 v5_server +5.1% |
| `tiny` | 1.5M | 追求极速时可用，但使用**独立的字符表**（从模型自带 `inference.yml` 提取，与 small/medium 的 50 语字典不通用） |

small/medium 共用 50 语合并字典（CTC 类别数 18710，含 index 0 的 blank）；本插件按「字典不含 blank、自动补位」的官方约定解码，v4/v5/v6 的 det/rec 接口一致，可混放旧版模型。若自定义模型的字典首行约定不同导致行首多出一个杂散字符，把该字符作为 `rec.dict.txt` 的第一行（空行）补上即可。

## 对话能力

**工具**（`wiki_*`）：库管理（`wiki_library_list/add/switch/remove`）、文件（`wiki_fs_upload/delete/reingest`）、检索（`wiki_search`）、页面（`wiki_list_pages` / `wiki_recompile` / `wiki_reindex`）、体检（`wiki_conflicts` / `wiki_lint` / `wiki_stats`）、规则（`wiki_schema_get/update`）。

**斜杠命令**：`/wiki-query <问题>`、`/wiki-conflicts`、`/wiki-lint`、`/wiki-reindex`。结果由适配器渲染，不进模型历史。

**自动注入**：每轮把与用户最新输入相关的片段注入 system prompt，并提示模型用 `wiki_search` 取原文；拿不到就不注入。默认检索 5 条候选、每条最多 2000 字符，整体不超过 `ambientMaxChars`（默认 4000，约 2 片完整 + 末条按剩余预算裁剪）——每轮注入保持便宜，深度检索交给工具；需要每轮都给足 5 片时把该值调回 `10000`。注入必须是同步的（host 的 `text` 契约），所以这一段走**字面检索**，语义检索留给 `wiki_search` 工具。

## 与参考方案的差异（按本仓库实测 API 对齐）

参考文档里的一些写法在真实 DSH 上不存在或签名不同，实现时按仓库实际契约改了：

| 参考文档写法 | 本仓库真实情况 | 这里的做法 |
|:---|:---|:---|
| `ctx.config` | 不存在；配置是 `apply(ctx, config)` 的第二参 | 直接读第二参，默认值在 `resolveSettings()` 里补 |
| `ctx.llm.complete({ prompt })` | 是 `llm.stream({ provider, model, messages })`，且 `messages[].content` 必须是内容块数组（`[{ type: 'text', text }]`），消息还需带 `id` 与 `source` | 路由依次取：每库在面板选的模型 → `compileProvider` / `compileModel` → DSH 默认模型 |
| `systemPrompt.section({ content, priority })` | 字段是 `text`（同步）+ `order` | 知识段改为同步字面召回 |
| `connection.broadcast(event, payload)` | 不存在 | 浏览器改为轮询 `ingest_jobs` RPC |
| `rpc.handle(channel, handler, { authority })` | 只有两参，鉴权内建 | 用两参；channel 用 `/wiki`（不能是 `/api`） |
| sqlite-vec / ANN 索引 | 需原生依赖 | 向量存 BLOB，在内存里做余弦；规模上不需要 ANN |
| 结构化指标靠 LLM 抽取 | 未配模型时不可用 | 改为确定性启发式抽取（`不得大于 / 不得低于 …`），只用于冲突预检 |
| `registry.json` 放 `~/.dsh-llm-wiki/` | 本工作区统一用 `dshHomePath('storages', …)` | 走 `$DSH_HOME/storages/llm-wiki/` |

## 安全边界

- 所有来自模型 / 浏览器的路径都过 `safeResolve()`：拒绝绝对路径、`..` 逃逸，并限制在 `raw/` 或 `wiki/` 前缀内。
- `raw/` 不在可写前缀里 —— 原始材料只能上传、删除、重新摄入，不能改写。
- 上传文件名经 `sanitizeFileName()` 归一为单个安全段，且已存在时拒绝覆盖。
- 编译器只写 `entities/`、`concepts/`、`sources/` 之下的 `.md`，其余路径一律拒绝，避免 LLM 覆盖 `schema.md` 或越界写文件。

## 目录

```
src/
  index.ts                 Host 面入口：工具 / 命令 / prompt 段 / RPC
  config.ts                配置与默认值
  service.ts               所有操作的唯一实现（四个入口都只是包装）
  types.ts  shims.d.ts     宿主与可选包的最小类型声明
  shared/                  路径安全、编码、分块、frontmatter、schema、检索、日志
  store/                   分块后端（SQLite 优先，JSON 兜底）+ 元数据
  features/                注册表、摄入队列、解析器、编译器、冲突、lint、召回、嵌入
  client/                  浏览器面：面板、三层标签页、RPC 封装、词典
```
