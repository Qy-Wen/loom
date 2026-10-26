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
CreativeAssets/          -- 用户选择的库根目录
├── product.jpg          -- 素材平铺 / 任意层级
├── video.mp4
├── 我的项目A/          -- 用户自建的任意层级
│   └── ...
├── notes.md
│
└── .loom/               -- 隐藏元数据目录（用户无需关心），不被索引
     ├── metadata-db/metadata.db   -- SQLite（元数据 + 向量 + FTS）
     ├── graph-db/graph.db/        -- LadybugDB
     ├── grades/luts/              -- 导入的 LUT
     └── agents/                   -- sessions/、command-allows/、skills/、memory/、traces/、tool-results/
```

完整结构与理由见 [LIBRARY_LAYOUT.md](./LIBRARY_LAYOUT.zh-CN.md)。

- 素材放在哪、如何嵌套、叫什么名字，都由用户决定。
- **Portable workspace**：用户将库目录整体拷贝到另一台机器（`.loom/` 随之携带），`Open Asset Library` 即可完整恢复。若 `.loom/` 丢失或损坏，也只需重新索引，素材本体不受影响。符合 Local-first 理念。Chat / embedding / rerank / VLM 的端点在应用设置里，不进 `.loom/`，见 [SETTINGS.md](./SETTINGS.zh-CN.md)。

### 3.2 SQLite — Metadata Store + Hybrid Search

SQLite 不只承担「向量检索」，而是承担整个资产库的元数据存储。数据库在 `<library>/.loom/metadata-db/metadata.db`：资产索引（`assets`）、库级键值（`library_meta`）、Obsidian 风格的自定义属性（`properties`、`asset_properties`），以及 Level 1 技术元数据（`asset_metadata`）。列定义见 [SCHEMA.zh-CN.md](./RAG/data/SCHEMA.zh-CN.md)。

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

```
(:Asset)-[:RELATED {type}]->(:Asset)
(:Asset)-[:REFERENCE_OF]->(:Asset)
(:Asset)-[:BELONGS_TO]->(:Project)
(:Asset)-[:USES_CHARACTER]->(:Character)
(:Asset)-[:SAME_SERIES]->(:Asset)
(:Asset)-[:PUBLISHED_TO]->(:Post)
```

用户可以手动拖一条线建立关联：

```
image_A
   │
   └── reference_of
            ↓
        video_B
```

关系由用户或 Agent 自己建立，包括用来记下派生文件从哪来：

```
product.png
     │ derived from
     ↓
image_gen_01.png
     │ derived from
     ↓
video_01.mp4
```

久而久之形成一张 **Creative Asset Graph**。

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

- 打开库时先扫完全盘再对账：先按 `file_system_id` 认人，再按相对路径；换卷则只认路径。避免边扫边删导致挪走的文件丢掉 UUID。
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

Level 2 先做切过的 **Markdown** embedding。规则见 [TEXT](./RAG/TEXT.zh-CN.md)。图 / 视频 / 音频先转成文字再切，见 [MEDIA](./RAG/MEDIA.zh-CN.md)。层级见 [RAG](./RAG/RAG.zh-CN.md)。

---

## 6. Agent 工具与创作层

Agent 通过工具调用外部能力。Loom 自管库：检索、FFmpeg、pi 工作区工具（`read` / `edit` / `write` / `bash`）。对话权限为 Basic、Standard（默认）、Full。创作运行时（ComfyUI 以及以后的）以 MCP server 挂上，不为每个 provider 写第一方客户端。权限和进程沙箱见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。

### 6.1 FFmpeg — 第一批 Agent Tools

第一版无需接入任何生成模型，仅凭 FFmpeg 就能支撑大量 Agent Workflow。

打开的素材库是工作目录。相对路径相对它解析，也允许绝对路径。未指定输出时封装工具默认写到 `outputs/`。`asset_id` 仍是内部身份（见第 4 节）。

**工具集：**

```
get_media_info      extract_frame       extract_clip
resize_video        crop_video          convert_format
run_ffmpeg
```

`run_ffmpeg` 是封装工具盖不住时的逃生口。`concat_video`、`change_speed`、`extract_audio`、`add_subtitle` 可以后做，先走 `run_ffmpeg`。

**示例：**

> 把所有横屏视频转成 9:16，并截取前 10 秒。

```
search_assets(type=video, aspect_ratio=16:9)
        ↓
parallel [
    ffmpeg.crop(...)
    ffmpeg.trim(...)
]
```

非常适合演示 Tool Calling。

### 6.2 创作走 MCP

ComfyUI，以及以后的 GPT Image / Kling / Seedance，都以 MCP server 挂上。Agent 调 `server__tool`；Loom 不内嵌各家 HTTP API。

```
Agent
 ↓
MCP host（stdio 或远程 HTTP）
 ↓
ComfyUI / 其他创作 server
```

若 server 写在库外，Agent 用 `bash` 或 `write` 拷进来，现有 watcher 收编。

> 后置：不上 `generate_image` / `generate_video` 这类屏蔽 provider 的封装。MCP 工具名保持可见。

---

## 7. 完整 Agent Loop 示例

> 用去年 AirPods 项目里效果最好的图片，做一个 15 秒竖屏短视频。

```
1.  understand_intent
2.  query_graph        Project = AirPods
3.  hybrid_search      rating / semantic / metadata
4.  inspect_assets
5.  plan_workflow
6.  MCP 创作工具       → ComfyUI（或其他 server）
6b. bash / write       → 必要时拷进库
7.  ffmpeg             → 9:16 → 15 sec
8.  save_file          outputs/airpods_short_v2.mp4
9.  index_asset
10. create_relationship
        new_video --"derived from"--> source_images
11. update_metadata
```

至此 Agent 形成从检索 → 创作 → 索引 → 溯源的闭环。

---

## 8. Electron UI 设计

整体气质：**Obsidian + Finder + Lightroom + Cursor**。

采用「左侧素材库 + 中央工作区 + 各自独立的聊天与详情窗口」布局，提供 Files / Table / Graph 等工作视图。聊天和详情一开始在右列合成两个页签，默认显示聊天。拖标题可以移动。靠近工作区中间靠下时会吸附成一条底边，和左右两边栏拼在一起。拖回右边缘会重新停靠，双击标题也会停靠。拖到另一个窗口中间会合并页签。在停靠区域，拖到槽位上边缘或下边缘可上下拼接，蓝色预览显示落点；每个槽位可有独立的 tab 组。拖分隔线调整高度，上下顺序和尺寸刷新后保留。首次点击图片编辑，Grade 默认合入右侧栏页签；以后打开恢复上次保存的位置。在页签栏里横向拖动可以交换两个页签的位置。把页签拖出去会重新分开。文件树可以在列表和图标之间切换。收藏是当前库里的一份文件名单，按 `asset_id` 存在 `.loom/metadata.db`，显示在文件树上方，默认收起。右键文件可以加入或取消。改名和移动后星标还在。标签也挂在这个 id 上，全库共用。在 Details 里添加或拿掉。文件树上方的每个标签可以像文件夹一样展开，看里面有哪些文件。自定义属性是表格里的列。用户和 Agent 都可以加字段、填写或清空单元格、改名或删除一列。Details 的 File 里只读显示当前文件上有值的字段，没有值的不出现。

> 面板注册、通用拖拽规则与持久化见 [面板布局](./PANELS.zh-CN.md)。

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
- Local Core 未来可独立为本地服务：

```
localhost:xxxx
POST /assets/search
POST /agent/run
POST /graph/query
```

这样将来把 Local Core 从 Node 替换为 Python / Go / Rust，或部署到云端，都不影响 UI。同时也让项目更容易被讲述为一个「后端 / Agent 系统项目」。

> **agent 通道已先行落地为 localhost 服务**：main 进程起一个 localhost HTTP server 承载 CopilotKit runtime，renderer 走 AG-UI 连它（见 AGENT.zh-CN.md §6）。UI 层暂时用 CopilotKit 现成聊天框，将来可深化为自研工作台（AG-UI 协议不变，后端不改）。

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

未来延伸至发布：

```
             Local Creative Agent
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
    ComfyUI        小红书          抖音
       ↓              ↓              ↓
     Create         Publish        Publish
```

---

## 10. 需要涵盖到的技术要点

后续根据实际场景逐步引入：

- **Skills：** 已做 — 从 `<library>/.loom/agents/skills/` 把 Agent Skills（`SKILL.md`）接到创作 Agent。不 vendor pi 的 coding-agent 外壳。见 [AGENT](./AGENT.zh-CN.md)。
- **多 Agent**：已做 — 主对话加上检索和生成专职。同一轮里互不依赖的调用一起跑。见 [AGENT](./AGENT.zh-CN.md)。
- **沙箱**：bash 和 FFmpeg 已进。生成任务走 MCP，不套这层。见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。
- **LangGraph**：用于复杂、可恢复的创作工作流编排。
- **微调 / LoRA**：根据实际效果与评测结果决定是否引入。
- **MCP 设置页**：已做 — 设置 → MCP tab。
- **Evals**：已做 — 评测 Agent、工具调用与检索效果。见 [EVALS](./AGENT/EVALS.zh-CN.md)。
- **对话资产引用：** 已做 — 输入框可贴库内资产；回答里的 `<asset_ref>` 块先按 `asset_id`、再按路径选中该文件。见 [AGENT](./AGENT.zh-CN.md) §5。
- **从某条消息分支：** 已做 — 当前会话可从任意一轮续聊，或用该前缀开新会话。见 [AGENT](./AGENT.zh-CN.md) §6.3d。
- **Human in the loop：** 已做 — Standard 确认库外的 `write` / `edit`；Basic 也确认 `bash` 和会写文件的 FFmpeg 工具。见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。
- **可观测性**：记录运行轨迹、工具调用、耗时与 token。