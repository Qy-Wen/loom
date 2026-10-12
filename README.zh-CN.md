[English](./README.md) | **简体中文**

# Loom

本地优先的 AI 创意素材管理工作台。文件系统是事实源，SQLite 和图数据库是认知层，Agent 是操作层。

## 功能

Loom 把一个文件夹变成你的素材库。个人相册、创作中的成片和草稿、平时收集来做参考的图片和视频，都可以放在一起看、一起找。目录怎么组织由你决定。整份文件夹拷到另一台机器，打开即可恢复。文件改名或移动之后，标签、收藏和关系还在。

**文件管理与浏览。** 左侧是素材库，文件树可以在列表和图标之间切换。点开一张图、一段视频、一段音频、一份 PDF 或一篇笔记，中间直接预览。Markdown 默认渲染，也可以切回源码。常用的文件可以收藏，也可以打上标签，按标签把同一类素材收在一起。

**理解与检索。** 接入多模态模型，为图片、视频和音频写下描述，再嵌入向量数据库。之后可以按意思找素材：记不清文件名，用一句模糊的话也能匹配到相近的画面、镜头或声音。对哪些素材做描述和嵌入，由你决定。

**素材图谱。** 素材之间的血缘由你来定。一张参考图、由此生成的新图、再剪出来的视频，可以用「派生自」「参考」这样的边连起来，长成自己的素材图谱。相册里的一组照片、一个项目的创作素材、爱好收集的参考，都能在这张图上看出从哪来、彼此怎么连。边上可以查看、添加和删除。

**自定义表格。** 文件夹之外，还可以把素材收成一张自己的表。列由你定义，例如状态、项目、评分，类型可以是文本、数字、勾选或日期。你可以加列、填格子、改名或删列，Agent 也可以。

**影像处理。** 集成了专业的影像和图片处理工具 FFmpeg。可以用它裁剪画面、调色、转码、压缩，也可以抽帧、截取片段。这些都在本地完成，处理好的文件回到素材库里。

**创作。** 通过 MCP 接入创作软件，例如 ComfyUI。Agent 调用这些工具生成新内容，再把文件放回素材库，并在图谱上记下它从哪些素材来。

**发布。** 计划把创作结果发到社交平台，让从找到素材、做成作品，到发出去，留在同一个工作台里。

**用对话操作。** 检索、表格、血缘、影像处理和生成都接到了 Agent 上。可以用对话按意思找素材、改一列表格、连一条关系、用 FFmpeg 裁剪、调色、转码或压缩，或让 ComfyUI 做一张新图。把库里的文件放进输入框，它就知道你在说哪一个。

## Agent

基于 [pi durable](https://github.com/earendil-works/pi/tree/main/packages/durable)。Durable 与 codemode 从上游同一 commit 源码级引入；Loom 在不修改上游源码的前提下增加库策略、specialist、MCP、检索、记忆、权限和进程沙箱。

- **多 Agent。** 主 Agent 负责对话、规划和文件变换（`read` / `edit` / `write` / `bash`、FFmpeg）。`run_retrieve_agent` 搜索并查看素材库。`run_create_agent` 调用 MCP 服务（如 ComfyUI），再把结果写回库。每次专职调用是一份持久化、归属工具任务的 conversation 和一条自包含任务。同一轮里互不依赖的调用一起执行。专职不能再派生子 Agent。父 Agent 只收到摘要，子工具卡片留在同一轮里。停止和权限确认同样作用在子 Agent 上。
- **RAG。** `search_assets` 用 RRF（`k = 60`）融合全文排名和子切片向量，可选 Rerank 再排一次。属性条件是硬 AND。命中是段落加上稳定的 `asset_id`，改名和移动保持同一身份。子切片可以扩到父切片（约 2048 token）。Markdown 先按结构切，再按 512 token 窗口、64 token 重叠切。图片、视频、音频先转成文本，再进同一套索引。向量和视觉理解由用户或 Agent 显式触发。
- **素材关系图。** LadybugDB 把有向边挂在 `asset_id` 上，例如「派生自」。Agent 用 `create_relation` 记下出处，`inspect_asset` 返回邻边。沿这些边做检索（Graph RAG）是下一步。
- **上下文工程。** 放进输入框的文件写成已存储消息里的 `<asset_ref>`。库选区在 submit 前折成 `<system-reminder>` 里的 `<ui_selection>` 并原样持久化，另外保存展示文字。选区变化不改写旧消息；memory 按会话冻结，技能目录在准备请求时重载。技能是 `.agents/skills/` 下的名称、说明和路径目录，需要步骤时再 `read` `SKILL.md`。
- **Memory。** 每个库一份 `.agents/memory/MEMORY.md`（大约 2000 字符），记偏好和约定。`auto_memory` 立即增加、替换或删除一条并写回文件。当前会话继续使用开场时读入的快照。操作步骤留在技能里。检索专职和创作专职没有这个工具。
- **沙箱。** 对话权限分为 Basic、Standard（默认）和 Full。进程沙箱默认开启：`bash`、`ffmpeg`、`ffprobe` 只能写当前库和临时目录，读不到用户主目录，也不能联网。Full 下这些进程直接运行。MCP 服务不进入这层沙箱。
- **MCP。** 创作服务以 MCP server 接入，支持本地 stdio 和远程 HTTP。工具注册成 `server__tool`，挂在创作专职上，主 Agent 不直接调用。设置里维护这份列表，ComfyUI 是其中一种。服务把文件写到库外时，由 `write` 或 `bash` 拷回库，再由监视器索引。

## 开发

```bash
pnpm install                          # 下载本机的 ffmpeg 和 ffprobe；Windows 上缺沙箱时安装一次
pnpm vendor:ffmpeg --all              # win32-x64、darwin-arm64、darwin-x64
pnpm dev                              # Electron 客户端（需 .env 里的 DEEPSEEK_API_KEY）
pnpm --filter @loom/app check:node-sqlite  # 验证真实 Electron 主进程的 SQLite
pnpm --filter @loom/agent try:durable  # 真实模型/工具 + 临时 SQLite/重开冒烟测试
pnpm test                            # 全部单元 / 集成测试
pnpm test:e2e                        # Playwright 冷启动（需先 build）
pnpm test:e2e:attach                 # Playwright 连上正在跑的 pnpm dev（:9344）
pnpm -r typecheck
```

## Vendor：pi durable 引擎

Loom 从上游 `main` 源码级 vendor pi 的 [`packages/durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) 与 `packages/codemode`，分别放在 `packages/agent/vendor-pi-durable/` 和 `vendor-pi-codemode/`。两份源码始终从同一 commit 同步。`src/durable-adapter.ts` 是 vendor import 边界，`src/durable.ts` 暴露 `@loom/agent/durable`，包含每库一个 Harness/Registry 的 `LibraryAgent` 与已提交的 title/archive 元数据。fork 标题追加 `（分支）`，默认未归档。Loom Chat 与 SQLite 冒烟链路已跑通；`createLibraryExtension` 已装配 durable 编码/Loom/auto-memory 工具与 prompt sections，memory 按会话冻结。root facade 与 app 已接入 durable 句柄/事件与 document 审批，specialist 改为归属前台 conversation。skills 与 tests/evals 已改为 durable，覆盖 specialist approve/reject/Stop/reopen 和并行执行。Electron 验证了子审批、reload/fork 与结束前显示文字，包含真实 DeepSeek。全仓库类型检查/测试通过；严格 live 工具金标为 3/4，等待审批时 SIGKILL/重开恢复通过，Windows 运行时和其他崩溃点覆盖仍待完成。见 [MIGRATION](./docs/agent/MIGRATION.zh-CN.md)。

### 同步上游

`vendor-clean` 保持纯净上游；在该分支同步、提交，再合并到 Loom 的 `main`：

```bash
git checkout vendor-clean
pnpm vendor:sync                       # 上游最新 main；可传 ref 参数
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi-durable main"
git checkout main
git merge vendor-clean
```

`vendor-pi-durable/sync.mjs` 浅克隆上游，将 `repo/directory/ref/commit` 写入 `UPSTREAM`，不写时间戳。macOS 用 `rsync --delete --delete-excluded` 镜像，原生 Windows 用等价的 Node 文件系统镜像；排除测试、`testing/` 与 benchmark。`sync.sh` 转发同一脚本。脚本拒绝在 `vendor-clean` 之外运行。

Loom 自有代码不要放进两份 vendor 的 `src/`，同步会删除其中的本地新增。codemode 目录是私有 workspace 包，保留上游包名与 exports，让 durable 源码无需修改；它只有 `quickjs-wasi` 仍从 npm 获取。同一 commit 重复同步不改变文件内容。外部依赖仍走 npm，每次同步 `main` 时需要核对上游依赖 API。

### Vendor 独立检查

```bash
pnpm --filter @loom/agent typecheck:vendor
pnpm --filter @loom/agent test:vendor
pnpm --filter @loom/agent build:vendor       # 先构建 codemode，再构建 durable
pnpm --filter @loom/agent test:vendor:build  # 验证编译后 JS 与 worker
```

源码测试无需预先构建。编译产物检查通过 `--conditions=loom-vendor-build` 选择 codemode 的 JS exports；开发默认使用源码 exports。旧 Loom 测试、eval 与 app 要等 harness import 迁移后才能运行。
