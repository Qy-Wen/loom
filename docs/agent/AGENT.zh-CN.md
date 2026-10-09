[English](./AGENT.md) | **简体中文**

# Agent 技术方案（Agent Architecture）

> 记录 Loom 的 Agent 层怎么实现：引入边界、解耦、合并上游更新、user 消息 attachments、前端交互协议（AG-UI）。
> 产品定位见 [PRODUCT.md](./PRODUCT.zh-CN.md) §6/§7，评测见 [EVALS.md](./EVALS.zh-CN.md)，待办见 [TODO.md](./TODO.zh-CN.md)。

---

## 1. 目标与定位

- Loom 的 Agent 是**创作资产 Agent**。主对话负责说话、计划和变换（`read` / `edit` / `write` / `bash`、FFmpeg、describe、embed）。`run_retrieve_agent` 和 `run_create_agent` 各起一个短命专职。Skills 从当前库的 `.agents/skills/` 加载。权限和进程沙箱见 [PERMISSION](./PERMISSION.zh-CN.md)。
- 素材库检索就是 RAG：Hybrid Search 返回文本段落（图 / 视频也是先写成字再切），Agent 用这些切片来回答或动手，而不是把整库塞进 prompt。见 [RAG](./RAG/RAG.zh-CN.md)。
- 目标之一是**锻炼 agent 工程能力**，因此对 agent loop 采取「源码级引入 + 按需魔改」，而不是当黑盒 SDK 用。
- 但只对**真正的核心**做源码级引入，基础设施（模型对接、provider）用现成 npm 包，避免被无关代码淹没。

---

## 2. 引入边界：只 vendor `packages/agent`，其余走 npm

> **明确：要源码级引入的是 pi 仓库的 `packages/agent`（npm 名 `@earendil-works/pi-agent-core`），即 agent loop 内核。**
> **不是 `packages/coding-agent`**——那是给终端编码场景的应用外壳（SessionManager / ResourceLoader / InteractiveMode / CLI / skills 装载…），强绑 TUI/CLI，Loom 用不上。

pi 的 agent 相关代码分三层，Loom 的处理方式不同：

| 层 | pi 包 | 体量 | Loom 处理 | 原因 |
|----|-------|------|-----------|------|
| agent loop 内核 | `packages/agent`（`pi-agent-core`）：`agent.ts` / `agent-loop.ts` / `execution` / `compaction` | ~核心几千行 | **源码级 vendor** | 这是要练、要改的主战场 |
| 模型对接 / provider | `pi-ai`（`packages/ai`） | ~24k 行，73% 是 provider 适配 | **npm 依赖**（先不 vendor） | 40+ 厂商对接是基础设施，不是 agent 能力 |
| 事件流 / 遥测 | `chord` / `pi-telemetry` | — | **npm 依赖** | agent loop 的运行时底座，telemetry 可注入 NOOP |

`pi-ai` 不 vendor 的原因：体量大且七成是厂商适配、拖着一堆重量级 SDK（`@anthropic-ai/sdk` / `openai` / `@google/genai` / `@aws-sdk/*`）。

**模型接缝：** `HarnessSessionManager` 用 `pi-ai` 构建当前 Chat 模型，再交给 `AgentHarness` lane。Loom 沿用 OpenAI 兼容的 Chat 设置，不 vendor `pi-ai`。

---

## 3. Vendor 策略（脚本同步 + pristine 分支）

> 用同步脚本把上游源码拷进 `vendor-pi-agent/`，用一条 pristine 分支隔离上游，靠 git 三方合并吃更新。
> （不用 submodule / subtree：它们对「只取一个子目录 + 随时魔改」都别扭。）

### 3.1 目录布局

vendor 目录直接放在 `@loom/agent` 包内（隶属该包，复用它的 `node_modules` 解析 pi 的外部依赖）：

```
packages/agent/                 # @loom/agent
├── package.json                # imports: "#vendor/pi-agent" → ./vendor-pi-agent/src/index.ts
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts                # Loom 自有工具、事件、设置
│   ├── harness-session-manager.ts # Harness 会话/运行时持有者
│   ├── pi-adapter.ts           # pi-ai Chat 模型及附件转换
│   └── pi-tools.ts             # 原生工作区工具和 Loom 工具适配
├── scripts/try-agent.ts        # 冒烟测试
└── vendor-pi-agent/
    ├── UPSTREAM                # 记录同步自哪个上游 commit / tag
    ├── src/                    # 从 pi 拷来的源码（可魔改）
    └── sync.sh                 # 同步脚本
```

### 3.2 同步脚本 `vendor-pi-agent/sync.sh`

按 ref 从 GitHub **浅克隆**到临时目录，拷 `packages/agent/src/` 到本目录 `src/`（剔除 test / testing / benchmark），把上游 commit 记进 `UPSTREAM`，再清理临时目录。默认 ref 为 `v0.85.1`。

**为什么从远程拉而非本地 pi 仓库：** 自包含——不依赖本机恰好有一份 pi clone，任何人 clone Loom 后都能直接跑；也不会改动你现有 pi 仓库的分支状态。

```bash
set -euo pipefail
REF="${1:-v0.85.1}"
REPO="https://github.com/earendil-works/pi.git"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$REF" --quiet "$REPO" "$TMP"
UPSTREAM_SHA="$(git -C "$TMP" rev-parse HEAD)"

rsync -a --delete \
  --exclude='**/*.test.ts' \
  --exclude='**/testing/**' \
  --exclude='benchmark/**' \
  "$TMP/packages/agent/src/" "$HERE/src/"

# UPSTREAM 记录 repo / directory / ref / commit
```

运行：`pnpm --filter @loom/agent vendor:sync [ref]`（根目录也有 `pnpm vendor:sync` 转发）。无需传 pi 路径。

### 3.3 引入与升级的统一工作流（核心）

**唯一心智模型：`vendor-clean` 分支始终是上游唯一真相（只放未魔改的 pi 源码），`main` 永远通过 `git merge` 从它获得 vendor。** 无论首次引入还是后续升级、无论你有没有魔改，都走同一条路——不用再判断「我改没改过」。

```bash
VENDOR=packages/agent/vendor-pi-agent

# 首次：从已含 vendor 的提交分出一条普通分支（非 orphan，与 main 有共同祖先）
git branch vendor-clean            # 此时 main 与 vendor-clean 同指一个含纯净 vendor 的提交

# 以后每次升级上游（固定四步）：
git checkout vendor-clean          # 1. 回到纯净分支
$VENDOR/sync.sh v0.86.0            # 2. 拉新版覆盖（见下：rsync 镜像语义）
git commit -am "vendor: pi-agent v0.86.0 (pristine)"
git checkout main                  # 3. 回主线
git merge vendor-clean             # 4. 三方合并：上游改动 vs 你的魔改，只在真冲突处停下
```

为什么统一走这条路：`vendor-clean` 始终是干净上游，`main` 承载魔改；升级时不冲突的上游改动自动合入，冲突只在你确实改过的地方出现。即使当前还没魔改，也从一开始就把轨道铺好，将来改了不用改流程。（早期用 orphan 孤儿分支也可，但需 `--allow-unrelated-histories`、且 git 图割裂，不如普通分支自然。）

**两条关键约束（否则会丢魔改）：**

1. **sync = rsync `--delete` 镜像覆盖，不做合并**。它把 `vendor/src` 变成与上游完全一致的镜像：新增拷入、变更覆盖、相同跳过、**上游已删的本地也删**。它不知道也不关心你的魔改——真正的三方合并交给 `git merge`。所以必须**只在 `vendor-clean` 上跑 sync**（该分支本就只有纯净上游，覆盖不会丢东西）。
2. **魔改只在 `main` 做，`vendor-clean` 永远保持纯上游**。你自己新增的代码应放在 `packages/agent/src/`（业务层），而非塞进 `vendor-pi-agent/src/`——后者下次 sync 会被 `--delete` 删掉。

### 3.4 外部依赖对齐

vendor 进来的 agent 仍需要 chord / pi-ai / pi-telemetry（及 diff / ignore / typebox / yaml）。把它们作为 `@loom/agent` 的 npm 依赖装上，**版本对齐 `UPSTREAM` 记录的 pi 版本**（pi 是同版本号发布，如 0.85.1）。升级 vendor 时一并对齐这些包的版本。

---

## 4. 解耦：Loom Agent 边界

> 核心原则：**Loom 的其余代码不 import `#vendor/pi-agent`，只使用 `@loom/agent` 暴露的 `HarnessSessionManager` 和 Loom 自有工具/事件类型。**

```
Loom 业务代码 → @loom/agent
                ├── types.ts                  # 工具、事件、设置
                ├── harness-session-manager.ts # 会话与 AgentHarness
                ├── specialist.ts             # 检索与生成子 Agent
                ├── library-skills.ts         # 从当前库加载 Agent Skills
                ├── pi-adapter.ts             # pi-ai Chat 模型与消息折叠
                └── pi-tools.ts               # 原生工具及 Loom 工具适配
                                 ↓
                          vendor-pi-agent/
```

只有 `harness-session-manager.ts`、`specialist.ts`、`library-skills.ts`、`pi-adapter.ts`、`pi-tools.ts` 引用 `#vendor/pi-agent`；应用只使用 Loom 导出的接口。Node 原生 `imports` 字段将 `#vendor/pi-agent` 和 `#vendor/pi-agent/node` 映射到 `vendor-pi-agent/`，tsconfig 对应配置保持一致。

### 注册工具（无需改上游源码）

- **工作区工具**：原生使用 Pi Harness 的 `createReadTool` / `createEditTool` / `createWriteTool` / `createBashTool` 与 `NodeExecutionEnv`。`cwd` 是打开的素材库；相对路径和绝对路径都可以。`read` 把 JPEG、PNG、GIF、WebP 附给模型；边长超过 2000 或 base64 超过约 4.5MB 时先缩小。BMP 等先转成 PNG。
- **素材库工具**：主对话保留 FFmpeg、`describe_*` 和 `embed_asset`。`search_assets` 与 `inspect_asset` 归检索专职。`search_assets` 是 RAG 的检索步：FTS 与子切片向量做 RRF，返回段落 + `asset_id`。
- **专职**：`run_retrieve_agent`（检索、查看、`read`）和 `run_create_agent`（名为 `server__tool` 的 MCP，外加 `write` / `bash`）。每次调用只有一份内存里的新对话和一段任务文字。需要 `asset_id` 时写进这段文字。同一轮里互不依赖的调用一起跑。专职不能再派生子 Agent。子工具卡片出现在同一轮里；父 Agent 只收到摘要。检索摘要用从工具结果抄来的 `<asset_ref>` 块点名文件。Stop 和权限确认同样作用于子 Agent。
- **MCP 客户端**：Main 读应用用户数据里的 `mcp.json`（或 `LOOM_MCP_CONFIG`），把工具注册成 `server__tool`，挂在生成专职上。设置页 MCP tab 改这份列表。任意 MCP server 都能挂；ComfyUI 只是其中一个例子。
- **系统提示词**：打开的素材库根目录就是工作目录。跨轮保持稳定。界面当前选中不写进这里。设置 → Agent 里的说明（应用用户数据里的 `AGENTS.md`）在会话开始时接到末尾，这一轮保持冻结。空着就不加。专职拿不到这段。
- **Skills：** 打开库时扫描 `<library>/.agents/skills/` 里的 Agent Skills（`SKILL.md`）。系统提示只放 name / description / location 目录。正文和相对路径文件由模型用 `read` 按需读取。Loom 不自动创建该目录，不扫库里其它位置，也不做技能斜杠命令。不 vendor `packages/coding-agent`。
- **自动记忆：** `<library>/.agents/memory/MEMORY.md` 记下这个库的事实。打开库时建好这个目录。`.agents` 不收成素材。会话把笔记读进系统提示一次，放在 skill 目录后面。`auto_memory`（`add` / `replace` / `remove`）立刻写文件；这一轮会话的系统提示保持冻结。检索专职和生成专职没有这个工具。见 [MEMORY](./MEMORY.zh-CN.md)。

---

## 5. User 消息的 attachments

> 系统注入上下文的 transcript 合同（先做 UI 选中）。气泡只显示 `content`。前缀缓存要求：同一条已落盘的 user，折进 Chat `content` 的字符串每次请求必须一样。

不要把会变的 UI 状态写进 system prompt（整段前缀都会废）。不要做 `get_selection` 工具。用户放进输入框的文件，发送时就已经展开写在 `content` 里。库里的高亮仍放在 `attachments`，只在组装 Chat 请求时再折。

### 5.1 落盘的 user 消息

Harness 持久化的 user 消息保留旁路字段。发出去之后这条 user 不再改。

```json
{
  "role": "user",
  "timestamp": 1727000000000,
  "content": [{ "type": "text", "text": "把这个处理一下" }],
  "attachments": [
    {
      "type": "ui_selection",
      "assetId": "a1b2c3d4-…",
      "path": "clips/hero.mp4",
      "assetType": "video"
    }
  ]
}
```

没有选中且输入框没有芯片时省略 `attachments`。不要存 `none` 占位。

发送时从当前库高亮快照（`assetId`、库内相对 `path`、`assetType`）写成一条 `ui_selection`。Graph 上的边不算选中。输入框也可以显式放入库内文件：从素材库拖到输入框，右键文件选 Add to chat，或点 + 菜单的 Library file。External file 和从访达拖入会先拷进 `Inbox/`（若文件已在库内则复用），再放入同一张芯片。发送时按 `assetId` 查当前库，把此刻的 `path` / `assetType` 写进块里。旧行不改。payload 里不要放发送时间这类每轮都变的字段。

芯片排在文字里，可以插在词与词之间。输入框读出文字时就在这个位置写上 `<asset_ref>` 块，聊天消息和落盘的 `content` 都是这串字。不再另存一条 `attachments`。气泡把这块解析回芯片。没有出现在芯片里的库高亮，接在原文后面，包在 `<system-reminder>` 里。标题只读文字，跳过芯片。点击芯片会在素材库里选中该资产。

回答里用同样的 `<asset_ref>` 块点名文件。气泡先按 `asset_id` 在当前素材库里查，蓝色显示该文件现在的路径。id 空着或不在库里时再对 `path`。还是对不上，写下的路径画成红色，不能点。还没写完的块在流出时保持文字。

```
看一下
<asset_ref>
path: clips/hero.mp4
asset_id: a1b2c3d4-…
type: video
</asset_ref>
这段
```

### 5.2 折给 Chat API

Chat 使用 OpenAI 兼容 `POST /v1/chat/completions`。不少服务只接受字符串 `content`，不要多个 text part。`pi-adapter` 的 `toProviderMessages` 先把落盘 user 消息的原文和附件**拼成一段字符串**，再交给 `convertToLlm`。主动放入的芯片在 `content` 里已经是这块，折的时候留在原位，只在后面补上剩下的库高亮。系统注入永远不做成第二个 text part。

输入框贴的是库芯片，不发像素。要看图/视频/音频，由 agent 自己调 `describe_image` / `describe_video` / `describe_audio` 或 `read`。

折法固定。HTTP 里没有 `attachments` 字段。

```
把这个处理一下<asset_ref>
path: clips/hero.mp4
asset_id: a1b2c3d4-…
type: video
</asset_ref>
```

剩下的库高亮用同样三个字段，包在 `<ui_selection>` 里，再整个放进用户原文后面的一个 `<system-reminder>`。提醒里写明这是素材库里选中的文件，和当前任务未必有关。未选中：只折用户原文，不要拼 `<ui_selection>none</ui_selection>`。

```
看一下

<system-reminder>
The user had this file selected in the library. This may or may not be related to the current task.

<ui_selection>
path: notes/brief.md
asset_id: …
type: text
</ui_selection>
</system-reminder>
```

System prompt 写明：`<asset_ref>` 是用户放进文字里的文件；原文后面的 `<system-reminder>` 是应用附上的上下文。用户说「这个 / 它」又没点名时用这些块；点了别的路径就听用户的。回答里点名库文件时，写同样的 `<asset_ref>` 块。`path` 和 `asset_id` 从结果里抄，没有 id 就省掉那一行，不要编造。

下一轮再快照库高亮。若与 transcript 里**最近一条** `ui_selection` 的 `assetId` 相同，本轮不挂这条 attachment、也不折——历史上还有那一块。先前的 `asset_ref` 即使是同一文件，也不压制下一轮的隐式 `ui_selection`。没有更早的 `ui_selection`，或换了文件，再按上面挂并折。旧行不改。同一轮的 tool 循环共用发送时那份快照。同一轮发送里，若芯片里已经有这个 `assetId`，就不再挂隐式 `ui_selection`。

---

## 6. 前端协议：CopilotKit + AG-UI，不暴露 Pi 运行事件

Pi Harness 发出进程内运行事件；`HarnessSessionManager` 对外提供较小的 `LoomAgentEvent` 流。两者都不是前端协议：`LoomAgUiAgent` 把 Loom 事件转换为 AG-UI，通过 SSE 发给前端。

### 6.1 接缝位置

前端 **暂时用 CopilotKit**（现成聊天 UI，走 AG-UI 协议）快速起步。CopilotKit 的数据流要求一个 HTTP runtime 端点，因此在 **Electron main 进程里起一个 localhost HTTP server** 承载它——这恰好落地 PRODUCT.md §9「Local Core 可抽成 localhost 服务」。

**为什么暂时用得踏实：把 CopilotKit 拆三层看，不会锁死。**

| 层 | 内容 | 深化成工作台时 |
|---|---|---|
| ① 协议 / runtime | AG-UI transport + runtime 端点 | **长期保留**，与 UI 无关 |
| ② React hooks | `useCopilotAction`（工具→自定义组件/generative UI）、`useCoAgent`（shared state）、`useCopilotReadable`（UI 状态喂给 agent） | **工作台里更有用** |
| ③ 现成 UI 组件 | `CopilotChat`（`@copilotkit/react-core/v2`）聊天框 | ⭐ 自己写工作台 UI 时替掉，但 ①② 继续用 |

即：深化成重工作台时，只换掉③的聊天框（几十行），后端（① runtime + `LoomAgUiAgent`）无需修改；generative UI / shared state 这些工作台核心能力反而能继续复用②。最坏情况完全弃用 CopilotKit，也因 AG-UI 是标准协议而不伤后端。

```
Renderer 进程
  @copilotkit/react-core/v2 ：CopilotKitProvider + CopilotChat（现成聊天框）
   │ HTTP / SSE，runtimeUrl = http://127.0.0.1:<port>/api/copilotkit
   ↓
Main 进程（Local Core）
┌────────────────────────────────────────────┐
│ localhost HTTP server                        │
│   └ CopilotKit runtime 端点                  │
│        └ LoomAgUiAgent（AG-UI 接缝）          │  LoomAgentEvent → AG-UI
│             └ HarnessSessionManager         │  @loom/agent
└────────────────────────────────────────────┘
   │ pi-ai
   ↓
大模型（DeepSeek…）
```

Pi Harness 事件与 `LoomAgentEvent` **都只停留在 main 进程内部**，对外只暴露 AG-UI。将来把 Local Core 从 main 抽成独立 localhost 服务、或把 pi 换成自研 agent，只要仍产出 AG-UI，前端零改动。

**实现要点**（已跑通）：

- 接缝继承 `@ag-ui/client` 的 `AbstractAgent`，实现 `run(input): Observable<BaseEvent>`（RxJS）。
- `@ag-ui/{client,core}` 用 **1.0.1**，与 `@copilotkit/runtime` 1.77.0 的依赖版本一致。
- Node 端点用 v2 `createCopilotNodeListener`；不用已 deprecated 的 v1 endpoint。
- 前端直接用 `@copilotkit/react-core/v2` 的 `CopilotKitProvider` + `CopilotChat`，无需 `@copilotkit/react-ui`。
- runtime 每次 run 会 clone 注册的 AG-UI agent；`LoomAgUiAgent.clone()` 保留共享的 `HarnessSessionManager` 和运行中操作映射。
- `HarnessSessionManager` 持有会话句柄，用 Pi `JsonlSessionRepo` 将新对话持久化在 `<library>/.loom/harness-sessions/`，从活跃路径读取历史。旧 v1 数据仍在 `<library>/.loom/sessions/`，不触碰。从历史提问分支见 §6.3d。

**server 落地要点**（都是标准做法，一次写好即忘）：

- `server.listen(0, "127.0.0.1")`：随机空闲端口 + 只绑本机（不绑 `0.0.0.0`），消除端口冲突与外部可达。
- 实际端口经 preload/IPC 注入 renderer，供 `<CopilotKitProvider runtimeUrl>` 使用。
- 先 `await listen` 再创建窗口，避免 renderer 早于 server；`app.on("will-quit")` 里 `server.close()`。

### 6.2 事件映射

`LoomAgUiAgent` 消费 `@loom/agent` 的 `LoomAgentEvent`，翻译成 AG-UI：

| `LoomAgentEvent` | AG-UI event |
|---|---|
| `agent_start` | `RUN_STARTED` |
| `text` (delta) | `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` |
| `thinking_start` / `thinking_delta` / `thinking_end` | `REASONING_START`、`REASONING_MESSAGE_*`、`REASONING_END` |
| `tool_pending` | `TOOL_CALL_START` + `TOOL_CALL_ARGS`，调用在批准前停住 |
| `tool_start` | 同一对事件；若 `tool_pending` 已经为该 `toolCallId` 发过则跳过 |
| `tool_progress` | `ACTIVITY_SNAPSHOT` `loom.tool_progress`，同一条原地更新；调用结束时收起 |
| `tool_end` | `TOOL_CALL_END` + `TOOL_CALL_RESULT`；结构化 `details` 另发 `CUSTOM loom.tool_result` |
| `retry_scheduled` / `retry_start` / `retry_end` | `ACTIVITY_SNAPSHOT` `loom.retry`。等待时显示，结束后收起 |
| `error` | 发 `loom-error-*` 提示条 + `RUN_ERROR`（key 错、Chat 连不上、没配设置）。按系统告警渲染，不走模型气泡。 |
| `agent_end` | `RUN_FINISHED` |

### 6.3 已保留的行为与后续产品交互

Harness 负责运行时；Loom 映射现有行为，下面只将明确列出的产品交互延后。

**a) thinking / reasoning**

- pi 的 `thinking_start` / `thinking_delta` / `thinking_end` 先变成同名 `LoomAgentEvent`，再映射成 AG-UI `REASONING_*`。已废弃的 `THINKING_*` 不会生成聊天消息。
- 丢弃 redacted。`thinkingSignature` / `thoughtSignature` 留在 transcript 里，不进前端协议。

**b) 工具富输出**

- pi 的 `AgentToolResult` 天然分两条通道：`content`（给模型看的文字）与 `details`（供 UI 渲染的结构化数据）。
- Loom 现在保留两条通道：文字映射为 `TOOL_CALL_RESULT`，结构化 details 发出 `CUSTOM loom.tool_result`。
- `search_assets` 与 `inspect_asset` 分别使用 `asset_list` 和 `asset_detail` 数据。聊天把这些文件画成链接，以 `asset_id` 为键。点击后在素材库里选中，不离开 Agent 标签。

**c) 停止对话**

- CopilotChat 的 Stop 会退订 AG-UI 流，并通过 `HarnessSessionManager.abort()` 请求取消。
- Harness 取消活跃操作，以及它启动的专职；中止信号传给工作区/素材库/MCP 工具、FFmpeg 子进程与模型请求。
- 用户主动 Stop 作为取消记录在 Harness 会话中，可与错误区分；不映射成 Chat `RUN_ERROR`。
- 运行中按 Enter 把文本排进 `followUp`。同一 run 在本可结束时继续，一次只插入一条，等这段结束后再插入下一条。排队文本留在输入框上方，插入后离开队列并作为用户消息出现在对话里。Stop 丢掉尚未插入的 followUp。`steer` 和 `nextRun` 不使用。

**d) 从之前的提问分支**

- 选中一条历史用户提问后，在那条消息上直接改，改完就地发送。发送时当前路径切到这条提问之前，旧路径留在树里。
- 也可以把该提问之前的前缀复制成新会话，标题在原标题前加上 `Fork: `，原会话不动。已经写下的文件不回退。

**e) 工具权限**

见 [PERMISSION](./PERMISSION.zh-CN.md)。

---

## 7. Evals

金标放在本仓库。CI 用假 Chat / 假向量，`--live` 打 `.env` 里的 Chat 和 Embedding 槽位。命令、指标和不做的事项见 [EVALS.md](./EVALS.zh-CN.md)。

---

## 8. 小结

- **vendor 一个包**：`pi-agent`（源码级、可魔改）。
- **npm 三个包**：`pi-ai` / `chord` / `pi-telemetry`，版本对齐 `UPSTREAM`。
- **合并上游**：`vendor-clean` pristine 分支 + `git merge` 三方合并。
- **解耦**：业务使用 `HarnessSessionManager` 与 Loom 自有工具/事件类型；只有 `@loom/agent` 引用 vendor Pi Harness。
- **User attachments**：主动放入的芯片是 user 消息 `content` 里的 `<asset_ref>` 块。库高亮（`ui_selection`）仍挂在 `attachments` 上，请求时再折进这段文字，包在 `<system-reminder>` 里。外部文件先拷进 `Inbox/`。芯片和工具结果里的文件名按 id 选中该资产。回答里的 `<asset_ref>` 块在 `asset_id` 还在当前素材库时按 id 选中该文件，否则按 `path`。
- **前端协议**：用 CopilotKit（AG-UI）+ main 进程 localhost server；`LoomAgUiAgent` 把 `LoomAgentEvent` 翻成 AG-UI，不暴露 Pi 运行事件。
- **工具权限和沙箱：** [PERMISSION](./PERMISSION.zh-CN.md)。
- **Evals：** 压缩率、prompt-cache 命中率、仓内 Agent/工具金标、检索 Recall@k / nDCG。见 [EVALS.md](./EVALS.zh-CN.md)。
- **当前范围**：生产聊天和新会话存储已切到 Harness；资产工具保留稳定调用 ID 和结构化结果。Stop 取消活跃操作，思考过程显示在聊天里。运行中 Enter 排入 followUp，该 run 在本可结束时继续。自动阈值压缩已开启。可以从历史提问分支。输入框可贴库内文件，对话里的资产引用可点。Skills 只把目录放进系统提示，模型按需 `read` `SKILL.md`。Standard 在库外的 `write` / `edit` 前先问。Basic 对 `bash` 和会写文件的 FFmpeg 工具也先问。`get_media_info` 不问。Full 不问。
