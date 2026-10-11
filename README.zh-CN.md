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

基于 [pi agent core](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`）扩展。它的 agent loop 以源码引入，Loom 在上面增加多 Agent、MCP、素材库检索、记忆、权限和进程沙箱。创作工具通过 MCP 接入。

- **多 Agent。** 主 Agent 负责对话、规划和文件变换（`read` / `edit` / `write` / `bash`、FFmpeg）。`run_retrieve_agent` 搜索并查看素材库。`run_create_agent` 调用 MCP 服务（如 ComfyUI），再把结果写回库。每次专职调用是一份新的内存对话和一条任务。同一轮里互不依赖的调用一起执行。专职不能再派生子 Agent。父 Agent 只收到摘要，子工具卡片留在同一轮里。停止和权限确认同样作用在子 Agent 上。
- **RAG。** `search_assets` 用 RRF（`k = 60`）融合全文排名和子切片向量，可选 Rerank 再排一次。属性条件是硬 AND。命中是段落加上稳定的 `asset_id`，改名和移动保持同一身份。子切片可以扩到父切片（约 2048 token）。Markdown 先按结构切，再按 512 token 窗口、64 token 重叠切。图片、视频、音频先转成文本，再进同一套索引。向量和视觉理解由用户或 Agent 显式触发。
- **素材关系图。** LadybugDB 把有向边挂在 `asset_id` 上，例如「派生自」。Agent 用 `create_relation` 记下出处，`inspect_asset` 返回邻边。沿这些边做检索（Graph RAG）是下一步。
- **上下文工程。** 放进输入框的文件写成已存储消息里的 `<asset_ref>`。库里的当前选中不进历史，请求时折进一条 `<system-reminder>` 里的 `<ui_selection>`，选区变化不会改写记录，也不会打掉提示词前缀。系统提示、技能目录和记忆快照在一次会话内保持不变。技能是 `.agents/skills/` 下的名称、说明和路径目录，需要步骤时再 `read` `SKILL.md`。
- **Memory。** 每个库一份 `.agents/memory/MEMORY.md`（大约 2000 字符），记偏好和约定。`auto_memory` 立即增加、替换或删除一条并写回文件。当前会话继续使用开场时读入的快照。操作步骤留在技能里。检索专职和创作专职没有这个工具。
- **沙箱。** 对话权限分为 Basic、Standard（默认）和 Full。进程沙箱默认开启：`bash`、`ffmpeg`、`ffprobe` 只能写当前库和临时目录，读不到用户主目录，也不能联网。Full 下这些进程直接运行。MCP 服务不进入这层沙箱。
- **MCP。** 创作服务以 MCP server 接入，支持本地 stdio 和远程 HTTP。工具注册成 `server__tool`，挂在创作专职上，主 Agent 不直接调用。设置里维护这份列表，ComfyUI 是其中一种。服务把文件写到库外时，由 `write` 或 `bash` 拷回库，再由监视器索引。

## 开发

```bash
pnpm install                          # 下载本机的 ffmpeg 和 ffprobe；Windows 上缺沙箱时安装一次
pnpm vendor:ffmpeg --all              # win32-x64、darwin-arm64、darwin-x64
pnpm dev                              # Electron 客户端（需 .env 里的 DEEPSEEK_API_KEY）
pnpm --filter @loom/agent try:agent   # 冒烟测试：跑通一轮 agent loop
pnpm test                            # 全部单元 / 集成测试
pnpm test:e2e                        # Playwright 冷启动（需先 build）
pnpm test:e2e:attach                 # Playwright 连上正在跑的 pnpm dev（:9344）
pnpm -r typecheck
```

## Vendor：pi agent 引擎

Loom 的 agent 内核**源码级 vendor** 自 [pi](https://github.com/earendil-works/pi) 的 `packages/agent`，放在 `packages/agent/vendor-pi-agent/`。业务代码只通过 `packages/agent/src/pi-adapter.ts`（唯一 `#vendor/pi-agent` 入口）使用它。

### 同步 / 升级上游

**心智模型**：`vendor-clean` 分支始终是上游唯一真相（只放未魔改的 pi 源码），`main` 通过 `git merge` 从它获得 vendor；所有魔改只在 `main` 上做。

**同步脚本**（`packages/agent/vendor-pi-agent/sync.sh`）：按 ref 从 GitHub 浅克隆到临时目录，`rsync --delete` 镜像覆盖 `vendor-pi-agent/src/`，把上游 `repo/directory/ref/commit` 记进 `UPSTREAM`。无需本地 pi 仓库；对同版本幂等（不写时间戳）。

```bash
# 首次：从已含 vendor 的提交分出普通分支（与 main 有共同祖先）
git branch vendor-clean

# 升级上游（固定四步）：
git checkout vendor-clean                             # 1. 回纯净分支
pnpm --filter @loom/agent vendor:sync v0.86.0         # 2. 拉新版镜像覆盖
git commit -am "vendor: pi-agent v0.86.0 (pristine)"  #    （同版本无改动时跳过）
git checkout main                                     # 3. 回主线
git merge vendor-clean                                # 4. 三方合并：上游改动 vs 魔改，只在真冲突处停下
```

**两条约束**（否则会丢魔改）：

1. `sync` 是 `rsync --delete` 镜像覆盖、不做合并——**只在 `vendor-clean` 上跑**（该分支本就只有纯上游，覆盖不丢东西）。
2. 魔改只在 `main` 做；自己新增的代码放业务层 `packages/agent/src/`，别塞进 `vendor-pi-agent/src/`（下次 sync 会被 `--delete` 删掉）。

**外部依赖**：vendor 的 agent 需要 `@earendil-works/{pi-ai,chord,pi-telemetry}`（及 `diff`/`ignore`/`typebox`/`yaml`），作为 `@loom/agent` 的 npm 依赖，版本对齐 `UPSTREAM` 记录的 pi 版本。
