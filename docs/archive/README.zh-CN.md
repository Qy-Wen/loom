[English](./README.md) | **简体中文**

# 已归档

已完成的步骤存档。当前待办见 [../TODO.zh-CN.md](../TODO.zh-CN.md)。

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
