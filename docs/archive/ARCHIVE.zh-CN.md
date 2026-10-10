[English](./ARCHIVE.md) | **简体中文**

# 已归档

已完成的步骤存档。当前待办见 [../TODO.zh-CN.md](../TODO.zh-CN.md)。

---

## 可观测性

一次提问的 run、turn、step、tool、模型请求记在内存里，走 Pi 现有的追踪。开发时单独开一个 Traces 窗口看瀑布图。点工具或模型 span 可看参数和返回值，或发给模型的消息和回复。每一边会截断。打包后没有这个窗口。累计 Stats 仍在设置里。

---

## 进程沙箱

`bash`、`ffmpeg`、`ffprobe` 默认跑在进程沙箱里。可写当前库和临时目录。用户目录不可读，再放开当前库、临时目录，以及 shell、ffmpeg、ffprobe 所在目录。这些进程没有网络。设置 → Agent 可以关掉。Full permission 直接跑，离开后恢复开关。`read`、`edit`、`write` 仍在进程内。生成任务走 MCP，不套这层。见 [PERMISSION](../agent/PERMISSION.zh-CN.md)。

---

## 自动记忆

当前库的事实在 `<library>/.agents/memory/MEMORY.md`。打开库时建好这个目录，不收成素材。会话读入一次，放在 skill 目录后面，这一轮保持冻结。`auto_memory` 立刻增、改、删。大约 2000 字，超出则报错并带上现有条目。做法仍写成 skill。检索专职和生成专职没有这个工具。见 [MEMORY](../agent/MEMORY.zh-CN.md)。

---

## 多 Agent

主对话负责说话、计划和变换。`run_retrieve_agent` 搜库、看素材。`run_create_agent` 用一段 brief 走 MCP 生成，不搜库。需要 `asset_id` 时写进 brief。同一轮里互不依赖的调用一起跑。专职不能再派生子 Agent。见 [AGENT](../AGENT.zh-CN.md)。

---

## Human in the loop

对话底部：Basic、Standard（默认）、Full。存在应用 userData，不进库。Standard 对库外的 `write` / `edit` 等确认，库内直接写。Basic 再对 `bash` 和会写文件的 FFmpeg 工具确认。`get_media_info` 不确认。Full 不确认，也不进沙箱。见 [PERMISSION](../agent/PERMISSION.zh-CN.md)。

---

## Agent 与检索评测

金标放在本仓库，不另开仓库。检索和 Agent/工具金标，CI 假槽位、现场真实槽位。见 [EVALS](../AGENT/EVALS.zh-CN.md)。

---

## 素材库 Skills

打开库时扫描 `<library>/.agents/skills/` 里的 Agent Skills（`SKILL.md`）。系统提示只放 name / description / location 目录。正文和相对路径文件由模型用 `read` 按需读取。Loom 不自动创建该目录，不扫库里其它位置，也不做技能斜杠命令。不 vendor `packages/coding-agent`。见 [AGENT](../AGENT.zh-CN.md) 和 [agentskills.io](https://agentskills.io/specification)。

---

## 对话资产引用

输入框以行内芯片贴库内文件。每张芯片是一条 `asset_ref`（`assetId`、库内相对 `path`、`assetType`）。发送时的库高亮是另一条字段相同的 `ui_selection`。点击芯片或 `search_assets` / `inspect_asset` 的 `asset_id` 会选中该文件，并留在 Agent 页。见 [AGENT](../AGENT.zh-CN.md) §5 和 §6.3b。

- 从素材库拖入、右键「添加到对话」，或 + →「素材库文件」。外部文件和从访达拖入会先拷进 `Inbox/`（已在库内则复用）。输入框贴的都是芯片，不发 `image_url`。
- 折的时候在芯片位置写 `<asset_ref>`。剩下的高亮接在后面，包在 `<system-reminder>` 里，写成 `<ui_selection>`。气泡不显示这段提醒。发送时按 `assetId` 查当前路径。旧行不改。下一轮是否省略高亮，只看最近一条 `ui_selection`。

---

## 素材库剪切与拖动

库内移动文件和文件夹，不换 `asset_id`。剪切（菜单或 Cmd/Ctrl+X）再粘贴，或拖到另一个文件夹（拖到文件树空白处则到库根目录）。复制仍会生成副本。文件夹不能拖进自己。目标已有同名时换成唯一文件名。

---

## 对话框图片输入

输入框可插入 JPEG、PNG、GIF、WebP（最多 4 张，每张 8 MB）。图片是用户消息 `content` 里的图片部分，气泡里能看见，并以 `image_url` 发给 Chat。没有视觉开关，也不自动重试。端点拒绝时界面报错，这一轮离开当前路径。会话文件里仍留着这条离开的分支。视频和音频不在这一步。DeepSeek-V4.1-Flash 收图片，不收视频。

---

## 从之前的提问分支

选中一条历史提问后在那条消息上直接改，发送时当前路径切到这条提问之前，旧路径留在树里。也可以把该提问之前的前缀复制成一个新会话，标题前加上 `Fork: `，原会话不动。已经写进素材库的文件保持原样。见 [AGENT](../AGENT.zh-CN.md) §6.3d。

---

## 运行中 followUp

运行中按 Enter，文本进入 vendor 的 `followUp`。同一 run 在本可结束的检查点继续，一次只插入队列中的第一条，等这段结束后再插入下一条。排队消息集中在输入框上方的一个队列区里；插入后离开队列，并作为用户消息出现在对话里。Stop 仍会丢掉尚未插入的 followUp。`steer` 和 `nextRun` 不使用。队列写进 Harness 会话，运行中崩溃可以留下；正常 Stop 不会留下。

---

## 自动阈值压缩

已启用 vendor 的自动阈值压缩（预留 16,384 token、保留约 20,000 token 近期上下文）。Chat 设置新增可选的上下文窗口，未配置时 128k 兜底。压缩事件转发到 AG-UI，transcript 里的 compaction 摘要可见。真实模型验证见 `packages/agent/evals/compaction-e2e.ts`（触发、锚点保留、压缩后召回均通过）。

---

## 生产聊天切换到 Pi Harness

- 用统一的 Harness 会话/运行管理器替代普通 pi `Agent` 和 Loom v1 transcript 写入。新会话位于素材库 `.loom/harness-sessions/`；旧 `.loom/sessions/` 文件不读取也不删除。
- 保留 AG-UI 聊天、原生工作区工具、素材库/FFmpeg/MCP 工具、Stop、选中资产附件、用量统计和会话操作。模型与 MCP 工具就绪后自动恢复未完成操作。
- 自动阈值压缩暂关，待验证模型窗口；溢出恢复保留。Agent、App、Core 测试及 Electron 会话冒烟测试覆盖此次切换。

---

## ✅ vendor pi-agent，纯 Node 跑通一轮 agent loop

源码级引入 pi 的 agent 引擎，喂一句话跑通一轮 tool calling（不碰 Electron / UI / DB）。

- pnpm workspace，`@loom/agent` 一个包；`vendor-pi-agent/` + `sync.sh` 同步 pi `packages/agent` @ `v0.85.1`
- npm 装 `@earendil-works/{pi-ai,chord,pi-telemetry}` + `diff`/`ignore`/`typebox`/`yaml`（对齐 0.85.1）
- `tsconfig.base.json` 对齐 pi 编译开关；vendor 引用用 node `imports` 字段 `#vendor/pi-agent`
- `src/{types.ts, pi-adapter.ts}`：`LoomAgent` 接口 + 唯一 vendor 入口；`scripts/try-agent.ts` 冒烟测试
- 跑通 `agent_start → tool_start → tool_end → text → agent_end`；vendor 同步走 `vendor-clean` 分支 + `git merge`
- 实测：DeepSeek 模型 id 是 `deepseek-v4-flash`（provider `deepseek`，读 `DEEPSEEK_API_KEY`）

---

## ✅ Electron 外壳 + agent 对话闭环

跑通「UI 输入 → agent → 大模型 → 流式回显」，暂不引入 DB / library。

- 新增 `@loom/app`：Electron main / preload / React renderer
- main 进程在 `127.0.0.1` 随机端口启动 CopilotKit Runtime，退出时关闭
- `LoomAgUiAgent` 将 `LoomAgentEvent` 翻译成 AG-UI 事件
- runtime endpoint 和 agent id 经类型化 IPC 注入 renderer
- renderer 使用 `@copilotkit/react-core/v2` 的 `CopilotKitProvider` + `CopilotChat`
- 跑通 `RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED`，typecheck / build / 启动通过

---

## ✅ 三层解耦 + 素材库骨架

用内存 Store 跑通「选择文件夹 → 扫描 → 文件树 → 预览 → watcher 实时更新」。

- 新增 `@loom/core`，分离 Renderer / Main / LocalCore；Renderer 不直接访问文件系统或数据库
- 定义 `MetadataStore` / `GraphStore` 接口及内存实现
- 实现 Library / LibraryPaths / LibraryWatcher，忽略 `.loom/` 和 `.DS_Store`
- 原生文件夹选择，扫描素材并使用 UUID 作为 `asset_id`
- 文件树显示目录层级与素材缩略图，目录默认折叠
- 中央工作区支持图片、视频、音频、PDF 和常见文本预览
- 三栏布局：Asset Library / Workbench / Agent 与 Details；分栏可拖动并保存宽度
- 文件支持原生右键操作：重命名、创建副本、复制路径、Finder 定位、移到废纸篓
- 组件拆分为 file tree、preview、sidebar、side panel 和 resizable layout
- `try:library` 覆盖扫描、watcher、重命名、复制与 UUID 保持；typecheck / build 通过

---

## ✅ SQLite MetadataStore

将内存资产索引替换为素材库内的 SQLite 持久化存储。

- 引入 `better-sqlite3`，数据库自动创建在 `<library>/.loom/metadata.db`
- 实现 `SqliteMetadataStore`：open / close / upsert / get / getByPath / list / remove
- 建立 `assets` 表、相对路径唯一约束、类型索引与 `user_version` schema 版本
- 默认 LocalCore 切换到 SQLite；`InMemoryMetadataStore` 继续保留用于轻量测试或注入
- 打开素材库时以文件系统为事实源：已有路径复用 UUID，新文件建档，失效记录移除
- 保留 watcher、预览和文件右键操作；显式重命名继续保持原 UUID
- 测试验证数据库创建、跨 LocalCore 重启 UUID 不变，以及离线删除后的索引同步

---

## ✅ 自定义属性 + Table 视图

加入带类型的持久化用户属性与结构化资产表格工作区。

- 支持 `text`、`number`、`boolean`、日期四种属性定义，并进行运行时校验
- 新增 `properties` 与 `asset_properties` SQLite 表，使用外键清理失效值
- 扩展 MetadataStore 与 LocalCore，支持属性定义和资产属性值的增删改查
- 将全库 reconcile 改为原地更新保留资产，移动和路径交换时不丢失属性
- Details 面板支持创建、编辑、清空和删除自定义属性
- 启用 Table 视图：动态属性列、按真实类型排序、文本过滤和行选择
- 测试覆盖内存与 SQLite Store、跨重启持久化、级联清理、非破坏性 reconcile 和 Table 类型排序

---

## ✅ Agent 资产检索工具

通过安全、结构化工具将真实本地素材库接入 Agent。

- 将 pi 的稳定 `toolCallId` 贯穿 Loom 事件与 AG-UI，支持同名工具重复调用
- 增加 `search_assets`：文件名/路径文本、资产类型与 AND 组合自定义属性过滤
- 增加 `inspect_asset`：单个资产的元数据、自定义属性与 renderer 安全预览引用
- 在 Electron Main 通过 `@loom/agent` 注册两个工具；模型和 UI 结果都不包含绝对文件系统路径
- 通过 `TOOL_CALL_RESULT` 与 `CUSTOM loom.tool_result` 同时保留模型文字和 `asset_list` / `asset_detail` 结构化通道
- 测试覆盖检索、结构化结果、非法参数、同名重复工具调用和路径安全边界

---

## ✅ 本地资产富化

补齐不依赖 AI 的 Level 1 技术元数据，按 `asset_id` 做本地缓存。

- 新增 `asset_metadata`：固定失效列（`version`、`source_modified_at`、`status`、`error`）+ 带 `kind` 的 JSON
- 从磁盘文件提取：图片尺寸与安全 EXIF、系统 `ffprobe` 音视频、txt/md/json/csv 限长文本
- 打开/reconcile 后自动刷新缺失或过期记录；Analyze 强制重跑；重命名/移动不重算
- Details 展示只读技术元数据并提供 Analyze
- 测试覆盖 PNG 尺寸、文本提取、mtime 失效、持久化与重命名跳过

---

## ✅ FFmpeg Agent 工具

让 Agent 用捆绑的 FFmpeg 做本地媒体处理，产物由 watcher 收编。

- `pnpm vendor:ffmpeg` 下载捆绑 `ffmpeg` / `ffprobe`（优先 npmmirror）；不进仓库，运行时从 vendor 再到 Electron `resources` 解析
- 封装工具：媒体信息、抽帧、裁剪片段、缩放、画面裁切、格式转换；不够用时用 `run_ffmpeg`
- 工具只收库内相对路径；绝对路径留在 Local Core
- 产物写在库内（默认 `outputs/`，可指定其它相对路径）
- 富化 ffprobe 走同一套捆绑二进制；聊天里显示工具结果 JSON
- 测试覆盖路径狱、真实 fixture 的抽帧/缩放/裁切/转码，无二进制时跳过

---

## ✅ 本地 Agent 会话

每个素材库多会话，形态对齐 pi 的 JsonlSessionRepo（create / open / list / delete，JSONL 只追加）。不走 CopilotKit 云 Threads。

- 会话文件落在当前库 `.loom/sessions/`；支持新建、切换、列表
- 关闭即归档（历史可再打开）；删除是单独动作，打开中不能删
- 重启后把 transcript 灌回 Agent，模型仍有上下文
- Agent 面板用会话 tab；第一条用户消息生成标题
- 聊天区通过 CopilotChat.View 画出已恢复的 JSONL（和本轮直播消息合并）
- 测试覆盖 CRUD/归档、打开中不能删、会话文件不进素材 watcher

---

## ✅ MCP 客户端

Loom 作为 MCP 客户端。第三方 server 和自家库工具并列挂上。

- Main 读 `mcp.json` 或 `LOOM_MCP_CONFIG`（stdio 与 Streamable HTTP）；命令、URL、凭据不进 renderer
- 工具注册成 `server__tool`，走同一套 Agent 循环；单个 server 失败就跳过
- Windows stdio 把 `npx` 改写成 `node.exe` + `npx-cli.js`（不能直接 spawn `.cmd`）
- 第一方仍是检索、FFmpeg、路径狱；不把创作 provider 写死在代码里
- 测试覆盖配置解析、命名前缀、错误上浮、host 跳过、PATHEXT 改写；真实 fetch 冒烟可选

---

## ✅ 产物出处

记下 FFmpeg 封装工具产物从哪来。边进 Ladybug，先不做 Graph 视图。

- Ladybug 落在 `.loom/graph.db`；`GENERATED_FROM` 是产物 → 源文件，按资产 UUID
- 封装工具立刻索引产物并写边；`run_ffmpeg` 不记
- `inspect_asset` 返回 `generatedFrom` / `generated`；Details 列出并可跳到另一端
- graph handlers MERGE / `DETACH DELETE` Asset 节点。测试覆盖持久化、级联删除、inspect，以及真实 fixture 的封装工具 vs 裸 `run_ffmpeg`

---

## ✅ 检索 Level 1 文本

`search_assets` 的子串匹配纳入已就绪的 `asset_metadata` 摘录。还没有 FTS 或向量。

- 文本文件用抽出的正文；图片用相机 / 拍摄时间；视频和音频用编码名
- `kind`、宽高、时长、失败/跳过的行不参与搜索
- 测试覆盖正文和相机命中，以及尺寸数字不会误中

---

## ✅ SQLite FTS5

`search_assets` 的文本查询改走 FTS5，不再整库内存扫描。属性过滤仍是 AND。没有向量。

- `assets_fts` 索引文件名、路径、属性值和已就绪的 Level 1 摘录
- 资产、属性、富化写入时刷新对应行；打开时行数对不上就重建
- 查询词按前缀 AND（`canon eos` → `"canon"* AND "eos"*`）

---

## ✅ 全库 Graph 画布

Graph 页是全库力导向画布。可平移、缩放，点节点选中。不做 Cypher 栏。

- 每个已索引资产是一个节点，Ladybug 的边画在它们之间
- 按素材类型着色；点击打开 Details
- 布局是渲染进程里的 Fruchterman–Reingold

---

## ✅ 手动建关系

用户自己建边、删边。类型是自由标签；`GENERATED_FROM` 仍留给 FFmpeg。

- 在 Graph 上把一个节点拖到另一个节点上，再填写类型（提示本库已用过的名字）
- Details：选另一个资产和类型；可从列表或选中的 Graph 边删除
- 存成 Ladybug `RELATED` 加 `type`；`(from, to, type)` 唯一
- `inspect_asset` 用 `links` 返回该资产的全部边

---

## ✅ Graph 交互

SVG 画布上的活力度场。坐标只留在本次会话。

- `d3-force`：拖节点本体来挪位置，周围会动，松手后停住
- 指针在圆边缘出现 `+`；从 `+` 拖出才建边
- 橡皮筋碰到其他节点时高亮并吸过去

---

## ✅ 图片 VLM

按需用 VLM 槽位给图写说明，再走已有的文本 embedding。导入不跑。

- OpenAI 兼容 `POST /v1/chat/completions`，消息里带 `image_url`（data URI）。本地和远程同一套 `baseUrl` + 可选 key + `model`。Loom 不加载、不运行模型
- 只做 JPEG / PNG / WebP / BMP。caption / 标签 Markdown 落在 `image_vlm`；mtime 没变的 rename/move 不重算；换 VLM 模型则说明作废
- Details Caption 和 `describe_image`；再用 `embed_asset` 把 Markdown 折进 `text_chunks`。Embedding 槽位空着时正文仍留下。不写 sidecar `.md`

---

## ✅ 视频 VLM

按需用同一套 VLM 槽位给视频写文件级说明，再走文本 embedding。导入不跑。镜头切块以后再做。

- 优先 OpenAI 兼容 `POST /v1/chat/completions` 的 native `video_url`（data URI，不超过 32 MB）。端点拒收或文件更大时，FFmpeg 抽 1–3 张临时 JPEG 再当 `image_url`。Loom 不加载、不运行模型
- avi / m4v / mkv / mov / mp4 / webm。caption / 标签 Markdown 落在 `video_vlm`；mtime 没变的 rename/move 不重算；换 VLM 模型则说明作废
- Details Caption 和 `describe_video`；再用 `embed_asset` 把 Markdown 折进 `text_chunks`。抽帧不进素材库。不写 sidecar `.md`

---

## ✅ Hybrid Search

`search_assets` 融合 FTS 排名和子切片向量。属性过滤仍是 AND。默认不整库 embedding。

- sqlite-vec（或 JS 余弦）只打已有向量的 **子切片**；child 命中可以扩到 parent
- 和 `assets_fts` 做 RRF 融合（`k = 60`）。返回 **段落 + `asset_id`**。Embedding 槽位空着或查询向量失败时退回 FTS
- 最小评测：`packages/core/tests/hybrid-search.test.ts`。见 [TEXT](../RAG/TEXT.zh-CN.md)

---

## ✅ 音频理解

按需用 Audio 槽位给独立音频写文件级说明，再走文本 embedding。导入不跑。

- OpenAI 兼容 `POST /v1/chat/completions`，消息里带音频部分。托管 Qwen-Omni 发 `input_audio` + `modalities: ["text"]` + `stream: true`。VLM 槽位仍只做视觉。Loom 不加载、不运行模型
- 端点拒收原格式时 FFmpeg 在本地转一版；体积上限比照视频。Markdown 落在 `audio_writeup`；mtime 没变不重跑；换 Audio 模型则说明作废
- Details 和 `describe_audio`；再用 `embed_asset`。见 [MEDIA](../RAG/MEDIA.zh-CN.md)

---

## ✅ Rerank

Hybrid Search 之后的可选第二轮。槽位空着就跳过。

- Cohere/Jina/千帆走 `POST /v1/rerank`（或 `/v2/rerank`），`query` + `documents`（融合后的段落）。百炼 `qwen3-rerank` 会把 DashScope Chat URL 改写成 `.../compatible-api/v1/reranks`
- 失败、只有一条命中、或槽位空着，都保持 RRF 顺序。开关探测发一次很小的 rerank POST（不是 `GET /v1/models`）
- TEI 原生 `texts` 以后再说。见 [TEXT](../RAG/TEXT.zh-CN.md) 和 [SETTINGS](../SETTINGS.zh-CN.md)

---

## ✅ 停止对话

CopilotChat 的 Stop 会中止 pi 这一轮和正在跑的工具。这一轮留在 transcript 里，不当成 Chat 报错。

- Stop 调用 `LoomAgent.abort()`。这会中止 Chat 流、bash、FFmpeg（`child.kill()`）、VLM/Audio/embedding/rerank 的 `fetch`，以及 MCP `callTool`
- 中止的这一轮仍追加到 JSONL。用户按下停止时，这一轮的正文会写明是主动取消，下一轮能把它和异常退出区分开

---

## ✅ 思考过程

模型的推理过程显示在对话里。签名留在 transcript 上。

- pi 的 `thinking_start` / `thinking_delta` / `thinking_end` 变成同名 `LoomAgentEvent`，再映射成 AG-UI `REASONING_*`。已废弃的 `THINKING_*` 不会生成聊天消息
- 丢弃 redacted。`thinkingSignature` / `thoughtSignature` 不进前端
- 重新打开会话时，未打码的思考过程仍会显示。见 [AGENT](../AGENT.zh-CN.md) §6.3a
