# Agent 技术方案（Agent Architecture）

> 记录 Loom 的 Agent 层怎么实现：引入边界、解耦、合并上游更新、前端交互协议（AG-UI）。
> 产品定位见 [PRODUCT.md](./PRODUCT.md) §6/§7，待办见 [TODO.md](./TODO.md)。

---

## 1. 目标与定位

- Loom 的 Agent 是**创作资产 Agent**，不是编码 Agent：工具是 `search_assets` / `hybrid_search` / `ffmpeg.*` / `comfyui.*` / `create_relationship` 等，而非 read/edit/bash。
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

1. **单一入口**：只有 `pi-adapter.ts` 允许 `import ... from "#vendor/pi-agent"`。（后续可用 ESLint `no-restricted-imports` 强制。）
2. **接口归 Loom**：`types.ts` 定义 `LoomAgent`，adapter 把它翻译成 pi 的 `Agent` API。将来换掉 pi，只改 adapter，上层不动。
3. **引用方式**：用 node 原生的 `imports` 字段（`package.json` 里 `"#vendor/pi-agent": "./vendor-pi-agent/src/index.ts"`）+ tsconfig `paths` 同名映射。选 `#` subpath imports 而非 TS 路径别名，是因为前者 typecheck 与运行时都认，无需打包步骤。

### 把编码 Agent 改造成创作 Agent（无需改上游源码）

这些都通过配置完成，不用动 vendor 里的代码：

- **关掉编码工具**：`noTools: "builtin"`（去掉 read/edit/bash…）。
- **注册 Loom 工具**：`customTools: [search_assets, hybrid_search, ffmpeg.*, comfyui.*, create_relationship, index_asset]`。
- **换系统提示词**：`systemPromptOverride` → 创作 Agent 提示词。
- **换上下文**：注入素材库信息，而非代码仓库。

---

## 5. 前端协议：用 AG-UI，不暴露 pi 的 AgentEvent

pi 的「协议」只是一个**进程内的 TypeScript 事件流**（`session.subscribe()` 暴露的 `AgentEvent` discriminated union），不规定 JSON 格式或传输方式。换协议 = 再写一个消费者：订阅 `AgentEvent`，翻译成 AG-UI，通过 SSE 发给前端。

### 5.1 接缝位置

```
pi Agent (Local Core / main 进程)
   │ subscribe((event: AgentEvent) => …)
   ↓
┌───────────────────────────────────┐
│ AgUiTranslator（Loom 写，唯一耦合点）│  pi 协议 ↔ AG-UI 协议
└───────────────────────────────────┘
   │ AG-UI events (SSE / WebSocket)
   ↓
前端（任何 AG-UI 兼容客户端）
```

`AgentEvent` **永远停留在 Local Core 内部**，对外只暴露 AG-UI。将来 pi 换成自研 agent，只要仍能产出 `AgentEvent`（或直接发 AG-UI），前端零改动。这与 PRODUCT.md §9「Local Core 可抽成 localhost 服务」一致。

### 5.2 事件映射

| pi `AgentEvent` | AG-UI event |
|---|---|
| `agent_start` | `RUN_STARTED` |
| `message_start` (assistant) | `TEXT_MESSAGE_START` |
| `message_update` (text_delta) | `TEXT_MESSAGE_CONTENT` |
| `message_end` | `TEXT_MESSAGE_END` |
| `tool_execution_start` | `TOOL_CALL_START` |
| `tool_execution_update` | `TOOL_CALL_ARGS` / 自定义 |
| `tool_execution_end` | `TOOL_CALL_END` |
| `turn_end` / `agent_end` | `RUN_FINISHED` |

### 5.3 两处 v1 不做、但架构留好位置

两处都不在 v1 实现，但 `AgUiTranslator` 里预留处理入口（占位 `case`），以免后续改动伤筋动骨。

**a) thinking / reasoning**

- pi 侧有三段式事件 `thinking_start` / `thinking_delta` / `thinking_end`（含 `redacted`、Google 特有的 `thoughtSignature`）。
- 未来映射到 AG-UI `THINKING_*`；丢弃 `redacted`；`thoughtSignature` 属 agent↔model 内部机制，**绝不进前端协议**。
- 留位：translator 里 `case "thinking_start" / "thinking_delta" / "thinking_end": break`。

**b) 工具富输出**

- pi 的 `AgentToolResult` 天然分两条通道：`content`（文字/图，给模型看）与 `details`（结构化数据，供 UI 渲染）。
- 未来：`hybrid_search` 结果集、`generate_image` 产物等 `details` 走 AG-UI `STATE_DELTA`（前端画廊面板订阅）；工具进度（ffmpeg/ComfyUI）走 `CUSTOM`。
- `details` 的统一 schema（按 `kind` 分类，如 `asset_list` / `generated`）等第一个工具（`hybrid_search`）落地时再定。
- 留位：v1 忽略 `details`、仅用 `content` 出纯文本；translator 对 `tool_execution_*` 保留处理入口。

---

## 6. 小结

- **vendor 一个包**：`pi-agent`（源码级、可魔改）。
- **npm 三个包**：`pi-ai` / `chord` / `pi-telemetry`，版本对齐 `UPSTREAM`。
- **合并上游**：`vendor-clean` pristine 分支 + `git merge` 三方合并。
- **解耦**：业务只依赖 `packages/agent/src/types.ts`，`pi-adapter.ts`（通过 `#vendor/pi-agent`）是唯一 vendor 入口。
- **前端协议**：用 AG-UI，`AgUiTranslator` 消费 `AgentEvent` 翻译，pi 协议不外泄。
- **v1 范围**：先跑通「问→答→工具」主链路；thinking 映射与工具富输出（`STATE_DELTA`/`CUSTOM`）暂不做，但 translator 均预留占位 `case`。
