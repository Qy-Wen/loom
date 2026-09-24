[English](./AGENT.md) | **简体中文**

# Agent 技术方案（Agent Architecture）

> 记录 Loom 的 Agent 层怎么实现：引入边界、解耦、合并上游更新、前端交互协议（AG-UI）。
> 产品定位见 [PRODUCT.md](./PRODUCT.zh-CN.md) §6/§7，待办见 [TODO.md](./TODO.zh-CN.md)。

---

## 1. 目标与定位

- Loom 的 Agent 是**创作资产 Agent**，同时挂上 pi 的工作区工具（`read` / `edit` / `write` / `bash`）和素材库工具（`search_assets`、`ffmpeg.*`、MCP）。路径 jail 和进程沙箱以后再加。
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

**关键接缝：`StreamFn`。** agent 与 ai 之间唯一的运行时耦合点——agent loop 通过 `streamFn` 调用模型：

```typescript
const agent = new Agent({
  initialState: { systemPrompt, model },
  streamFn: models.streamSimple.bind(models),  // ← agent ↔ ai 的唯一接缝
});
```

因此 `pi-ai` 可随时替换：将来若要深入模型层，只需局部 vendor `pi-ai/api` + 单个 provider，无需现在整包搬。

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
│   ├── types.ts                # LoomAgent 接口（稳定，业务只依赖这里）
│   └── pi-adapter.ts           # 唯一 import #vendor/pi-agent 的地方
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

## 4. 解耦：单一 adapter 入口

> 核心原则：**Loom 的其余代码永远不 import `#vendor/pi-agent`，只 import 自己的 adapter。**

```
Loom 业务代码
      │  只依赖 Loom 自己的接口（packages/agent/src/types.ts）
      ↓
packages/agent/src/
  ├── types.ts        # LoomAgent 接口：prompt / subscribe …（你拥有）
  └── pi-adapter.ts   # 唯一 import #vendor/pi-agent 的文件，做 pi ↔ Loom 翻译
        │
        ↓
   vendor-pi-agent/   # 上游源码 + 魔改
```

约束落地：

1. **Vendor 边界**：只有 `pi-adapter.ts` 和 `pi-tools.ts` 允许 `import ... from "#vendor/pi-agent"`。（后续可用 ESLint `no-restricted-imports` 强制。）
2. **接口归 Loom**：`types.ts` 定义 `LoomAgent`，adapter 把它翻译成 pi 的 `Agent` API。将来换掉 pi，只改 adapter，上层不动。
3. **引用方式**：用 node 原生的 `imports` 字段（`package.json` 里 `"#vendor/pi-agent": "./vendor-pi-agent/src/index.ts"`）+ tsconfig `paths` 同名映射。选 `#` subpath imports 而非 TS 路径别名，是因为前者 typecheck 与运行时都认，无需打包步骤。

### 注册工具（无需改上游源码）

- **工作区工具**：用 `NodeExecutionEnv` 包一层 pi 的 `createReadTool` / `createEditTool` / `createWriteTool` / `createBashTool`。`cwd` 是打开的素材库；相对路径和绝对路径都可以。
- **素材库工具**：`search_assets`、`inspect_asset`、`ffmpeg.*`，以及之后的 `create_relationship`。
- **MCP 客户端**：Main 读 `mcp.json`（或 `LOOM_MCP_CONFIG`），把工具注册成 `server__tool`。ComfyUI 这类创作运行时从这里挂。
- **系统提示词**：打开的素材库根目录就是工作目录。

---

## 5. 前端协议：CopilotKit + AG-UI，不暴露 pi 的 AgentEvent

pi 的「协议」只是一个**进程内的 TypeScript 事件流**（`session.subscribe()` 暴露的 `AgentEvent` discriminated union），不规定 JSON 格式或传输方式。换协议 = 再写一个消费者：订阅 `AgentEvent`，翻译成 AG-UI，通过 SSE 发给前端。

### 5.1 接缝位置

前端 **暂时用 CopilotKit**（现成聊天 UI，走 AG-UI 协议）快速起步。CopilotKit 的数据流要求一个 HTTP runtime 端点，因此在 **Electron main 进程里起一个 localhost HTTP server** 承载它——这恰好落地 PRODUCT.md §9「Local Core 可抽成 localhost 服务」。

**为什么暂时用得踏实：把 CopilotKit 拆三层看，不会锁死。**

| 层 | 内容 | 深化成工作台时 |
|---|---|---|
| ① 协议 / runtime | AG-UI transport + runtime 端点 | **长期保留**，与 UI 无关 |
| ② React hooks | `useCopilotAction`（工具→自定义组件/generative UI）、`useCoAgent`（shared state）、`useCopilotReadable`（UI 状态喂给 agent） | **工作台里更有用** |
| ③ 现成 UI 组件 | `CopilotChat`（`@copilotkit/react-core/v2`）聊天框 | ⭐ 自己写工作台 UI 时替掉，但 ①② 继续用 |

即：深化成重工作台时，只换掉③的聊天框（几十行），后端（① runtime + AgUiAdapter）一行不改；generative UI / shared state 这些工作台核心能力反而能继续复用②。最坏情况完全弃用 CopilotKit，也因 AG-UI 是标准协议而不伤后端。

```
Renderer 进程
  @copilotkit/react-core/v2 ：CopilotKitProvider + CopilotChat（现成聊天框）
   │ HTTP / SSE，runtimeUrl = http://127.0.0.1:<port>/api/copilotkit
   ↓
Main 进程（Local Core）
┌────────────────────────────────────────────┐
│ localhost HTTP server                        │
│   └ CopilotKit runtime 端点                  │
│        └ AgUiAdapter（Loom 写，唯一耦合点）   │  LoomAgentEvent ↔ AG-UI
│             └ @loom/agent（pi agent loop）    │
└────────────────────────────────────────────┘
   │ streamFn
   ↓
大模型（DeepSeek…）
```

`@loom/agent` 暴露的 `LoomAgentEvent`（进而 pi 的 `AgentEvent`）**永远停留在 main 进程内部**，对外只暴露 AG-UI。将来把 Local Core 从 main 抽成独立 localhost 服务、或把 pi 换成自研 agent，只要仍产出 AG-UI，前端零改动。

**实现要点**（已跑通）：

- 接缝继承 `@ag-ui/client` 的 `AbstractAgent`，实现 `run(input): Observable<BaseEvent>`（RxJS）。
- `@ag-ui/{client,core}` 用 **0.0.59**，与 `@copilotkit/runtime` 1.73.0 的依赖版本一致。
- Node 端点用 v2 `createCopilotNodeListener`；不用已 deprecated 的 v1 endpoint。
- 前端直接用 `@copilotkit/react-core/v2` 的 `CopilotKitProvider` + `CopilotChat`，无需 `@copilotkit/react-ui`。
- runtime 每次 run 会 clone 注册的 agent；需覆盖 `clone()`，把 adapter 的 agent 配置带到实例副本。
- 会话 transcript 以只追加的 JSONL 落在当前库 `.loom/sessions/`。adapter 第一次碰到某个 thread id 时用 `initialMessages` 恢复，每轮结束后再 append 新增消息。

**server 落地要点**（都是标准做法，一次写好即忘）：

- `server.listen(0, "127.0.0.1")`：随机空闲端口 + 只绑本机（不绑 `0.0.0.0`），消除端口冲突与外部可达。
- 实际端口经 preload/IPC 注入 renderer，供 `<CopilotKitProvider runtimeUrl>` 使用。
- 先 `await listen` 再创建窗口，避免 renderer 早于 server；`app.on("will-quit")` 里 `server.close()`。

### 5.2 事件映射

`AgUiAdapter` 消费 `@loom/agent` 的 `LoomAgentEvent`（它已是 pi `AgentEvent` 的精简子集），翻译成 AG-UI：

| `LoomAgentEvent` | AG-UI event |
|---|---|
| `agent_start` | `RUN_STARTED` |
| `text` (delta) | `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` |
| `tool_start` | `TOOL_CALL_START` + `TOOL_CALL_ARGS`，保留 pi 的稳定 `toolCallId` |
| `tool_end` | `TOOL_CALL_END` + `TOOL_CALL_RESULT`；结构化 `details` 另发 `CUSTOM loom.tool_result` |
| `agent_end` | `RUN_FINISHED` |

### 5.3 两处 v1 不做、但架构留好位置

两处都不在 v1 实现，但 `AgUiAdapter` 里预留处理入口（占位 `case`），以免后续改动伤筋动骨。

**a) thinking / reasoning**

- pi 侧有三段式事件 `thinking_start` / `thinking_delta` / `thinking_end`（含 `redacted`、Google 特有的 `thoughtSignature`）。
- 未来映射到 AG-UI `THINKING_*`；丢弃 `redacted`；`thoughtSignature` 属 agent↔model 内部机制，**绝不进前端协议**。
- 留位：adapter 里预留 thinking 处理入口（需先在 `LoomAgentEvent` 补上 thinking 事件）。

**b) 工具富输出**

- pi 的 `AgentToolResult` 天然分两条通道：`content`（给模型看的文字）与 `details`（供 UI 渲染的结构化数据）。
- Loom 现在保留两条通道：文字映射为 `TOOL_CALL_RESULT`，结构化 details 发出 `CUSTOM loom.tool_result`。
- `search_assets` 与 `inspect_asset` 分别使用 `asset_list` 和 `asset_detail` 数据。当前聊天壳负责传输，后续工作台渲染器会将其显示为可交互资产卡片。
- FFmpeg / ComfyUI 的进度以后可继续增加其他 `CUSTOM` 事件。

---

## 6. 小结

- **vendor 一个包**：`pi-agent`（源码级、可魔改）。
- **npm 三个包**：`pi-ai` / `chord` / `pi-telemetry`，版本对齐 `UPSTREAM`。
- **合并上游**：`vendor-clean` pristine 分支 + `git merge` 三方合并。
- **解耦**：业务只依赖 `packages/agent/src/types.ts`，`pi-adapter.ts`（通过 `#vendor/pi-agent`）是唯一 vendor 入口。
- **前端协议**：用 CopilotKit（AG-UI）+ main 进程 localhost server；`AgUiAdapter` 把 `LoomAgentEvent` 翻成 AG-UI，pi 协议不外泄。
- **当前范围**：「问→答→工具」主链路已完成；资产工具已经保留稳定调用 ID 和结构化结果。thinking 映射与富结果交互渲染暂时后置，并保留明确扩展点。
