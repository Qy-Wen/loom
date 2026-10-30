[English](./PRODUCT.md) | **简体中文**

# Loom — Local-first AI Creative Workspace

> 一个本地优先的 AI 创意智能资产库。
> 文件系统负责资产本体，SQLite / 图数据库负责理解与索引，Agent 负责检索、组织、加工与创作。

---

## 1. 一句话定位

> **文件系统是事实源，数据库是资产的认知层，Agent 是操作层。**

Loom 是一个 Electron 桌面客户端，以本地运行为主，云端能力暂不考虑。用户选择一个文件夹作为「素材库」，Loom 自动以该目录作为工作目录，在其中提供实时预览、结构化属性、资产关联、语义检索，并让 Agent 能够调用 FFmpeg、ComfyUI 等工具完成从检索到创作再到发布的完整闭环。

---

## 2. 核心原则

1. **文件系统是唯一事实源（Source of Truth）**
   - 数据库不拥有文件本体。数据库损坏，最多重新索引，绝不能导致资产丢失。
   - 这是本项目最重要的设计约束。

2. **Local-first**
   - 所有能力默认本地运行，用户数据不出本地。
   - 云端 / 付费能力（如 VLM 理解）是可选的增量，而非前提。

3. **Progressive Enrichment（渐进式富化）**
   - 不是所有文件都值得做 AI 理解。用户主动选择是否为某个资产做 embedding / 语义分析。
   - 避免「一导入就疯狂烧 API 钱」。

---

## 3. 三层数据职责

严格分离三层数据职责，避免相互越界。

```
本地文件系统
    ↓
Asset Identity / Metadata
    ↓
┌────────────────┬─────────────────┐
│ SQLite         │ LadybugDB       │
│ 搜索/属性/向量 │ 资产关系图      │
└────────────────┴─────────────────┘
        ↓
      Agent
        ↓
FFmpeg / ComfyUI / Publisher / ...
```

### 3.1 文件系统 — 素材事实源

Loom **不强加任何目录结构**。素材默认平铺在库根目录内，层级关系完全由用户自行组织（就像在 Finder / Obsidian 里一样）。Loom 只在库根目录下额外维护一个隐藏目录（`.loom/`）来存放数据库与缓存等元数据，除此之外不干预用户的文件布局。

```
CreativeAssets/                   -- 用户选择的库根目录；Loom 不强加结构
├── product.jpg                   -- 素材平铺 / 任意层级
├── video.mp4
├── 我的项目A/                    -- 用户自建的任意层级
│   └── ...
├── notes.md
├── Inbox/                        -- 输入框导入；普通目录，会被索引
├── outputs/                      -- 工具默认输出；普通目录，会被索引
│
└── .loom/                        -- Loom 拥有的全部内容；用户无需关心，不被索引
    ├── metadata-db/
    │   └── metadata.db           -- SQLite：资产、属性、元数据、向量、FTS（含 -wal、-shm）
    ├── graph-db/
    │   └── graph.db/             -- LadybugDB EXPORT 目录
    ├── grades/
    │   └── luts/*.cube           -- 从库外导入的 LUT（首次导入时才创建）
    └── agents/
        ├── sessions/loom.sqlite  -- durable 会话存储（含 -wal、-shm）
        ├── command-allows/command-allows.json   -- 记住的命令
        ├── skills/               -- SKILL.md 目录
        ├── memory/MEMORY.md
        ├── traces/telemetry.sqlite   -- 仅开发模式
        └── tool-results/<conversationId>/<taskId>.txt
```

库根目录没有第二个保留目录，`.agents` 之类的名字都归用户。这些路径只由 `core` 的 `LibraryPaths` 决定。

Loom 写到系统临时目录的内容都放在同一个根下，不进素材库，崩溃也不会在库里留文件：

```
<os.tmpdir()>/loom/
├── grade/run-*/{preview,frames}/   -- 调色面板用的 ffmpeg 静帧；每个媒体服务一个 run-*
├── vlm-frames/run-*/               -- 送给 VLM 的视频帧；每个素材处理完就删
├── audio/run-*/                    -- 转写用的压缩音频；每个素材处理完就删
├── composer/run-*/                 -- 剪贴板图片进入 Inbox/ 的中转；导入后就删
├── sandbox/                        -- 进程沙盒的 spec 文件和 spawn 辅助脚本
└── e2e/<pid>/                      -- Playwright 运行时 Electron 的 userData
```

路径只由 `core/src/temp.ts` 构造，不写死 `/tmp`（进程沙盒只能写素材库和 `os.tmpdir()`）。应用启动时清掉超过 24 小时的残留。

- 素材放在哪、如何嵌套、叫什么名字，都由用户决定。
- **Portable workspace**：用户将库目录整体拷贝到另一台机器（`.loom/` 随之携带），`Open Asset Library` 即可完整恢复。`.loom/` 是用户数据，不是缓存：标签、收藏、属性、关系、聊天会话、记忆和技能只存在那里，没有备份和导出，每个素材的 id 也记在其中。若 `.loom/` 丢失或损坏，搜索索引和描述可以重建，其余内容丢失，素材本体不受影响。符合 Local-first 理念。Chat / embedding / rerank / VLM 的端点在应用设置里，不进 `.loom/`，见 [SETTINGS.md](./SETTINGS.zh-CN.md)。

### 3.2 SQLite — Metadata Store + Hybrid Search

SQLite 不只承担「向量检索」，而是承担整个资产库的元数据存储。数据库在 `<library>/.loom/metadata-db/metadata.db`：资产索引（`assets`）、库级键值（`library_meta`）、Obsidian 风格的自定义属性（`properties`、`asset_properties`），以及 Level 1 技术元数据（`asset_metadata`）。列定义见 [SCHEMA.zh-CN.md](./RAG/SCHEMA.zh-CN.md)。

用户可以自由创建属性字段，例如：

```
状态       = 已发布
品牌       = Apple
项目       = 秋季 Campaign
摄影师     = xxx
评分       = 4
是否精选   = true
```

这类结构化数据放 SQLite（而非图数据库），因为它们是典型的结构化查询：

```
品牌 = "Apple"
AND 状态 = "已发布"
AND rating >= 4
```

再叠加：

- **FTS**（全文检索）
- **Vector Search**（向量检索）
- **Metadata Filter**（属性过滤）

三者结合，正好形成 **Hybrid Search**。这一步检索，再加上 Agent 用返回的段落来回答或动手，就是 Loom 的 RAG。见 [RAG](./RAG/RAG.zh-CN.md)。

### 3.3 LadybugDB — 资产关系图

图数据库专门负责「关系」，有真实业务语义，而非「为了图数据库而图数据库」。

当前只有一种节点和一种边：

```
(:Asset {asset_id})-[:RELATED {relation_id, type}]->(:Asset)
```

`type` 是自由文本（如 `reference_of`、`derived from`），由用户或 Agent 建立：用户可以在界面里手动拖一条线，Agent 用 `create_relation` / `remove_relation`。最常见的用法是记下派生文件从哪来：

```
product.png
     │ derived from
     ↓
image_gen_01.png
     │ derived from
     ↓
video_01.mp4
```

搜索不沿关系扩展。关系图用来记录和浏览出处，Agent 用 `inspect_asset` 读取一个文件的邻居（见 [RAG](./RAG/RAG.zh-CN.md)）。久而久之形成一张 **Creative Asset Graph**。

---

## 4. Asset Identity（关键设计）

**绝不使用文件路径作为 asset id。** 一旦用户重命名 / 移动文件，用路径作主键会导致所有属性与关系断裂。

```
asset_id = UUID（稳定、不随路径变化）
path     = 当前文件路径（可变，仅作定位）
```

资产的 metadata、属性、关系图统统挂在 `asset_id` 上，`path` 只是它当前所在位置的一个可变指针。

### File Watcher

监听文件系统事件并更新数据库：

- `add`
- `remove`
- `rename`
- `modify`

跨平台用 Node `fs.stat` 的 `(dev, ino)` 作为 `file_system_id`（macOS/Linux 是 inode，Windows 是卷序列号 + 64-bit file index）。这是操作系统给文件的身份，不是 Loom 的 UUID。`asset_id` 仍是 UUID；`file_system_id` 只用来判断「还是不是刚才那个文件」。

- 打开库时先扫完全盘再对账：先按 `file_system_id` 认人，再按相对路径；换卷则只认路径。按路径认人时不要求 `file_system_id` 相同：已知路径上的文件就是那个资产，哪怕身份变了，比如编辑器用「写临时文件再改名」保存，或从备份恢复。代价是：Loom 关闭期间删掉一个文件、在原路径放进另一个不同的文件，新文件会继承它的标签等数据。文件被挪走时先按身份匹配，所以旧路径不会留住这个资产。避免边扫边删导致挪走的文件丢掉 UUID。
- 识别到增 / 删 / 移 / 更新后走 `LibraryHandlers`：metadata 与图各有处理函数。图侧在 Ladybug 里 MERGE / `DETACH DELETE` `Asset` 节点。
- 开着时 watcher 事件停稳后再走同一套全盘对账，避免整夹改名或对调时边跟边删丢掉 UUID。
- `file_system_id` 拿不到（FAT 等）或 inode 已被回收：退回路径匹配；hash 校验后置。
- 打开库时对比已存的卷 id（root 的 `stat.dev`）和当前卷。整库换盘导致卷变了：只按相对路径对齐，刷新全部 `file_system_id`，并记下新卷。

---

## 5. Progressive Enrichment（渐进式富化）

资产的理解程度分层递进，用户可控、成本可控。**不是所有文件都值得做 AI 理解**——用户主动选择是否为某资产做 embedding / 语义分析，避免「一导入就疯狂烧 API 钱」。

```
Level 0  Filesystem metadata        免费
   ↓
Level 1  FFprobe / EXIF / 文本提取   本地计算
   ↓
Level 2  Embedding                  可选
   ↓
Level 3  VLM Semantic Understanding 可选、可能收费
   ↓
Level 4  Deep Analysis              可选
```

Level 1 是从文件提取的本地技术元数据缓存（尺寸、时长、相机、文本）。存在 `asset_metadata` 里，打开库或文件变化时自动提取。就绪记录按源文件 `mtime` 和提取器版本失效；失败记录在下次打开或 reconcile 时重试。

Level 2 先做切过的 **Markdown** embedding。规则见 [RAG](./RAG/RAG.zh-CN.md#文本索引)。图 / 视频 / 音频先转成文字再切，见 [RAG](./RAG/RAG.zh-CN.md#图片视频音频)。

---

## 6. Agent 工具与创作层

Agent 通过工具调用外部能力。Loom 自管库：检索、FFmpeg、pi 工作区工具（`read` / `edit` / `write` / `bash`）。对话权限为 Basic、Standard（默认）、Full。创作运行时（如 ComfyUI）以 MCP server 挂上，不为每个 provider 写第一方客户端。权限和进程沙箱见 [PERMISSION](./agent/PERMISSION.zh-CN.md)。

### 6.1 FFmpeg — 第一批 Agent Tools

第一版无需接入任何生成模型，仅凭 FFmpeg 就能支撑大量 Agent Workflow。

打开的素材库是工作目录。相对路径相对它解析，也允许绝对路径。用户没指定路径时，Agent 把结果写到 `outputs/`。`asset_id` 仍是内部身份（见第 4 节）。

**工具集：**

```
grade_image         run_ffmpeg          run_ffprobe
```

`run_ffmpeg` 负责除静态图调色（`grade_image`）以外的所有媒体编辑，描述里带有抽帧、截取、缩放、裁切和转格式的 argv 示例。`run_ffprobe` 返回 ffprobe 的 stdout，Agent 用它读取时长、分辨率和编码。两者都只传不含程序名的 argv 数组；二进制随应用打包，不一定在 shell PATH 里，Agent 不得在 `bash` 里运行。

**示例：**

> 把所有横屏视频转成 9:16，并截取前 10 秒。

```
search_assets(type=video)          -- 找出视频
        ↓
run_ffprobe(...)                   -- 读分辨率，挑出横屏
        ↓
run_ffmpeg(...) × N                -- 每个视频一次：裁成 9:16 并截取前 10 秒，同轮互不依赖的调用一起跑
```

### 6.2 创作走 MCP

ComfyUI、GPT Image、Kling、Seedance 等创作服务都以 MCP server 挂上。Agent 调 `server__tool`；Loom 不内嵌各家 HTTP API。

```
Agent
 ↓
MCP host（stdio 或远程 HTTP）
 ↓
ComfyUI / 其他创作 server
```

若 server 写在库外，Agent 用 `bash` 或 `write` 拷进来，现有 watcher 收编。

---

## 7. 完整 Agent Loop 示例

> 用去年 AirPods 项目里效果最好的图片，做一个 15 秒竖屏短视频。

下面是示意流程，列的是做事的顺序，工具名以实际注册的为准：

```
1.  deep_search_assets   属性 项目=AirPods、评分 >= 4，加语义 query
2.  inspect_asset        看候选的元数据、说明和关系
3.  MCP 创作工具          → ComfyUI（或其他 server）
3b. bash / write         必要时把结果拷进库
4.  run_ffmpeg           → 9:16 → 15 秒
5.  文件落到 outputs/     airpods_short_v2.mp4，watcher 自动索引
6.  create_relation
        new_video --"derived from"--> source_images
7.  set_asset_property   状态 = 草稿
```

至此 Agent 形成从检索 → 创作 → 索引 → 溯源的闭环。

---

## 8. Electron UI 设计

整体气质：**Obsidian + Finder + Lightroom + Cursor**。

布局是「左侧素材库 + 中央工作区 + 各自独立的聊天与详情窗口」，工作视图有 Files / Table / Graph。

**链接。** 窗口始终停留在应用自己的页面。无论来自聊天回复、Markdown 预览还是脚本，网页和邮件链接都交给系统浏览器打开，不会新建窗口。其他链接（`file:`、`javascript:`、自定义协议）一律拒绝，跳出应用的重定向也拒绝。原因是窗口向页面暴露了 `loom` 桥接，一个把页面替换掉的链接会把这个桥接交给外部网站。页面进程崩溃时窗口会重新加载，每分钟最多三次；超过后保持原样，并在日志里说明。

**面板**
- 聊天和详情一开始在右列合成两个页签，默认显示聊天。
- 拖标题移动面板；靠近工作区中间靠下时吸附成一条底边，和左右两边栏拼在一起。拖回右边缘或双击标题重新停靠。
- 拖到另一个窗口中间合并页签；在停靠区域拖到槽位上边缘或下边缘可上下拼接，蓝色预览显示落点，每个槽位可有独立的 tab 组。
- 在页签栏里横向拖动交换两个页签；把页签拖出去会重新分开。拖分隔线调整高度；上下顺序和尺寸刷新后保留。
- 首次点击图片编辑时，Grade 默认合入右侧栏页签；以后打开恢复上次保存的位置。

**文件标签页（Files 视图）**
- 工作区用浏览器式的标签页显示已打开的文件。单击文件在当前标签页里显示；中键点击，或右键菜单选“在新标签页中打开”，会在当前标签页旁边新开一个。
- 同一个文件最多只在一个标签页里打开。左右拖动标签页调整顺序；也可以把文件从文件树拖到标签条里打开。
- 关闭标签页（点 × 或中键）会显示相邻的一个；文件被删除或移出素材库时它的标签页自动关闭。
- 标签页不跨重启保存，也不保留视图状态：切走后缩放、播放位置和未保存的调色修改都会重置。Details 和 Agent 跟随当前标签页。

**文件树、收藏、标签与属性**
- 文件树可以在列表和图标之间切换。
- 收藏是当前库里的一份文件名单，按 `asset_id` 存在 `.loom/metadata-db/metadata.db`，显示在文件树上方，默认收起。右键文件加入或取消；改名和移动后星标还在。
- 标签也挂在 `asset_id` 上，全库共用，在 Details 里添加或拿掉。文件树上方的每个标签可以像文件夹一样展开，看里面有哪些文件。
- 自定义属性是表格里的列。用户和 Agent 都可以加字段、填写或清空单元格、改名或删除一列。Details 的 File 里只读显示当前文件上有值的字段，没有值的不出现。

面板布局的实现约定：

- 新增面板只在 `App.tsx` 注册（`PanelRegistration`：稳定 `id`、标题、可见性、renderer，可选初始位置与首次打开策略），不在布局 hook、拖拽几何、tab 或 CSS 里按 ID 分支。已保存的位置优先于默认位置；隐藏且从未打开的面板不占槽位；注销注册项会清掉过期 ID。
- 每个槽位保存有序 tabs、活动 tab、位置和尺寸权重；权重按当前可见槽位归一化，拖出或隐藏其他槽位后仍填满区域。浮动槽位保存相对 shell 的矩形。
- 布局存在 `localStorage` 的 `loom.layout.panels`（带版本）；列宽与中央区域高度是独立设置。
- 面板注册和浮动的 e2e（`registered-panels`、`registered-float`）只在带 `LOOM_E2E_PANELS=1` 的 `build:e2e` 构建下运行，普通生产构建不含 fixture 入口。

## 9. 架构

### 进程解耦：Renderer / Main / Local Core

```
Electron Renderer
       ↓ IPC
Electron Main
       ↓
Local Core
```

- Renderer **绝不**直接操作 DB。
- agent 通道是 localhost 服务：main 进程起一个 localhost HTTP server 承载 CopilotKit runtime，renderer 走 AG-UI 连它（见 [AGENT](./agent/AGENT.zh-CN.md) §6）。聊天界面使用 CopilotKit 的聊天组件。

### 能力分层总览

```
                Agent
                  │
          ┌───────┴───────┐
          │               │
      Retrieval        Creation
          │               │
   SQLite + Vector    FFmpeg / ComfyUI
          │
       Asset Graph
          │
      LadybugDB
          │
      Filesystem
```

---

## 10. 已具备的技术要点

- **Skills：** 从 `<library>/.loom/agents/skills/` 把 Agent Skills（`SKILL.md`）接到创作 Agent。不 vendor pi 的 coding-agent 外壳。见 [AGENT](./agent/AGENT.zh-CN.md)。
- **多 Agent**：主对话加上检索和生成专职。同一轮里互不依赖的调用一起跑。见 [AGENT](./agent/AGENT.zh-CN.md)。
- **沙箱**：bash 和 FFmpeg 在沙箱内。生成任务走 MCP，不套这层。见 [PERMISSION](./agent/PERMISSION.zh-CN.md)。
- **MCP 设置页**：设置 → MCP tab。
- **Evals**：评测 Agent、工具调用与检索效果。见 [EVALS](./agent/EVALS.zh-CN.md)。
- **对话资产引用：** 输入框可贴库内资产；回答里的 `<asset_ref>` 块先按 `asset_id`、再按路径选中该文件。见 [AGENT](./agent/AGENT.zh-CN.md) §5。
- **从某条消息分支：** 当前会话可从任意一轮续聊，或用该前缀开新会话。见 [AGENT](./agent/AGENT.zh-CN.md) §3。
- **Human in the loop：** Standard 确认库外的 `write` / `edit`；Basic 也确认 `bash` 和会写文件的 FFmpeg 工具。见 [PERMISSION](./agent/PERMISSION.zh-CN.md)。
- **可观测性：** 开发模式下记录运行轨迹、工具调用、耗时与 token，存 `.loom/agents/traces/telemetry.sqlite`。见 [TRACE](./agent/TRACE.zh-CN.md)。