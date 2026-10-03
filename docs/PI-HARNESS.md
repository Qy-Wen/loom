# Pi Harness 接入范围

> 记录 Loom 从普通 pi `Agent` 直接迁往已 vendor 的 `AgentHarness` 时的能力边界。待办顺序见 [TODO](./TODO.zh-CN.md)；本文件描述迁移目标与 vendor 能力，不表示下面列出的能力均已接入。

## 结论与边界

- **目标：** Pi Harness 负责 Agent 运行、会话树及对话持久化；Harness 会话是新对话的唯一数据源，不与 Loom 旧 JSONL 双写。保留 Loom 的素材库、FFmpeg、MCP、模型设置、AG-UI/CopilotKit 和 Electron UI。旧 Loom v1 会话不迁移、不兼容、不读取、不主动删除；已有用户文件必须原样保留。
- **范围：** 直接在生产聊天链路切到 Harness，移除普通 pi `Agent`、旧 Core v1 repo 和逐消息写入；不先搭建并行运行链路，也不为追求“全部接入”而启用所有 vendor 功能。历史提问分支已接入。素材引用与 Skills 的产品交互随后实现。自动阈值压缩已接入。模板不因 vendor API 加入产品。运行中的插话走 `followUp`。
- **来源：** Vendor 是 pi `packages/agent`，不是 `packages/coding-agent` 的 CLI/TUI。后者的 `/tree`、`/fork` 选择器不能通过创建 Harness 自动获得。见 [UPSTREAM](../packages/agent/vendor-pi-agent/UPSTREAM)、[AGENT](./AGENT.md)。

## 切换边界

旧链路是 `CopilotChat → CopilotKit / AG-UI → LoomAgUiAgent → PiAgentAdapter → pi Agent → pi-ai + LoomTool`，会话另外写入 Core 自有的线性 v1 JSONL。目标链路是 `CopilotChat → CopilotKit / AG-UI → LoomAgUiAgent → AgentHarness → pi-ai + Harness 工具`；新对话由 Harness 的 `JsonlSessionRepo` 持久化在 `<library>/.loom/harness-sessions/`。旧 v1 数据在 `<library>/.loom/sessions/` 原样保留，不读取、不移动；素材库、FFmpeg、MCP、模型设置和 UI 继续由 Loom 承接。

## Vendor 能力与 Loom 接入职责

| 能力 | Vendor 提供什么；Loom 还需接什么 |
|---|---|
| **会话树 / lane / fork** | `JsonlSessionRepo` 管理持久条目、分支 tip、整树或路径 fork；lane 可导航、读当前路径。需接管会话生命周期、名称/归档/删除和 UI 的活跃路径投影。Pi 的 v4 JSONL 不识别 Loom v1 文件。见 [session/types.ts](../packages/agent/vendor-pi-agent/src/harness/session/types.ts#L520-L601)、[jsonl/codec.ts](../packages/agent/vendor-pi-agent/src/harness/session/jsonl/codec.ts#L49-L63)。 |
| **运行恢复与取消** | Harness 记录操作状态；`AgentHarness.create()` 返回未完成操作清单但**不自动续跑**。需定义应用启动/重连时如何处理 open operation、Stop 如何对应持久取消，以及与 AG-UI 断连的关系。见 [runtime/harness.ts](../packages/agent/vendor-pi-agent/src/harness/runtime/harness.ts#L374-L408)、[agent-harness.ts](../packages/agent/vendor-pi-agent/src/harness/agent-harness.ts#L538-L565)。 |
| **自动压缩 / 导航摘要** | Vendor 的自动阈值压缩默认开启：预留 16,384 token，保留约 20,000 token 近期上下文；另有手动 `compact()`，导航摘要需显式开启。Loom 此次切换暂不启用自动阈值压缩：真实模型上下文窗口、阈值触发时机和附件摘要语义在后续工作中验证；此次切换仍须验证溢出恢复。见 [compaction.ts](../packages/agent/vendor-pi-agent/src/harness/compaction/compaction.ts#L146-L161)、[agent-harness.ts](../packages/agent/vendor-pi-agent/src/harness/agent-harness.ts#L550-L559)。 |
| **重试 / 工具调度 / 插话队列** | 默认开启可重试错误的重试（最多 3 次额外重试）及并行工具；提供持久 `steer`、`followUp`、`nextRun` 队列。Loom 接入的是 `followUp`：运行中 Enter 排队，同一 run 在本可结束时继续，一次只插入一条；输入框上方列出排队文本，插入后离开队列并出现在对话里，Stop 丢掉尚未插入的队列。`steer` 与 `nextRun` 未接入。见 [runtime/harness.ts](../packages/agent/vendor-pi-agent/src/harness/runtime/harness.ts#L59-L72)、[config.ts](../packages/agent/vendor-pi-agent/src/harness/config.ts#L1-L4)。 |
| **Skills / 提示词模板** | 有 `SKILL.md` 加载器、`resources`、显式 `lane.skill()`/`promptFromTemplate()` 和系统提示词格式化工具；**不会自动扫描素材库、注入提示词或产生 UI 命令**。见 [skills.ts](../packages/agent/vendor-pi-agent/src/harness/skills.ts#L38-L77)、[harness/types.ts](../packages/agent/vendor-pi-agent/src/harness/types.ts#L43-L80)、[agent-harness.ts](../packages/agent/vendor-pi-agent/src/harness/agent-harness.ts#L518-L535)。 |
| **Hooks / 事件 / 统计 / 遥测** | 提供请求、工具、上下文、压缩、导航钩子，运行事件及会话 usage；钩子需应用注册。遥测未注入 context 时为 no-op。需把事件和用量映射到 AG-UI 与 Loom 原有累计统计；不必为没有场景的 hook 编写空实现。见 [agent-harness.ts](../packages/agent/vendor-pi-agent/src/harness/agent-harness.ts#L255-L332)、[agent-harness.ts](../packages/agent/vendor-pi-agent/src/harness/agent-harness.ts#L586-L611)、[harness/context.ts](../packages/agent/vendor-pi-agent/src/harness/context.ts#L27-L36)。 |

## 迁移时必须保留的 Loom 行为

1. **单一会话数据源：** 用 Harness session 存储新对话，移除旧 Core 逐消息写入。Loom 的标题、归档状态和会话列表仍需产品层承接；Harness `open()` 返回需要关闭的真实句柄。见 [jsonl/repo.ts](../packages/agent/vendor-pi-agent/src/harness/session/jsonl/repo.ts#L99-L110)。
2. **现有工具与真实调用上下文：** 工作区工具改为原生 Harness 工具；素材库/FFmpeg/MCP 工具需适配 Harness 的执行签名、取消、`details`、调用 ID 和进度。不要把有外部副作用的工具擅自标成可安全重放。见 [harness/types.ts](../packages/agent/vendor-pi-agent/src/harness/types.ts#L89-L121)、[mcp/tools.ts](../packages/app/src/main/mcp/tools.ts#L8-L21)。
3. **模型和工具热更新：** 继续使用现有 Chat 设置的 pi-ai 模型；已持久化的 lane 保存模型身份和活跃工具名，切换 Chat 设置或 MCP 工具列表时须同步更新，否则请求可能找不到模型或工具。后续启用自动阈值压缩前须核实真实端点的模型上下文长度，不能依赖未经验证的固定注册值。见 [generation.ts](../packages/agent/vendor-pi-agent/src/harness/runtime/drive/generation.ts#L68-L99)。
4. **附件、Stop、UI 与用量：** 保留用户选择 `attachments` 的模型可见折叠；如需覆盖 Harness 消息转换，核查以后启用压缩/分支摘要的另一条转换路径。Stop 的可见说明不能仅写在会被上下文过滤的 aborted assistant 上。保留 thinking、工具详情、历史展示与累计用量统计。见 [harness/session/context.ts](../packages/agent/vendor-pi-agent/src/harness/session/context.ts#L24-L43)。
5. **已有会话数据：** 不做 Loom v1→Pi v4 迁移或双读，也不读取、移动、覆盖或主动删除现有 v1 用户文件；新会话应可创建、重启、恢复、归档/删除，旧文件不应被错误识别为新会话。见 [jsonl/codec.ts](../packages/agent/vendor-pi-agent/src/harness/session/jsonl/codec.ts#L49-L63)。

## 不应算作已提供的功能

- Vendored 包不包含 `packages/coding-agent` 的终端 UI、`/tree` 选择器、自动 MCP host、权限审批流程、工作区路径 jail、沙箱、Git worktree 或多 Agent 编排；这些仍是 Loom 的产品/环境职责。Harness 工具的路径解析并不自动限制在库内。见 [AGENT](./AGENT.md)、[tools/path-utils.ts](../packages/agent/vendor-pi-agent/src/harness/tools/path-utils.ts#L13-L15)。
- `watchSession()` 当前明确未实现；会话搜索仅定义接口，没有现成索引服务。不能用“全部接入”描述这些能力。见 [runtime/harness.ts](../packages/agent/vendor-pi-agent/src/harness/runtime/harness.ts#L305-L307)、[search/index.ts](../packages/agent/vendor-pi-agent/src/search/index.ts#L1-L27)。
- 独立的 vendor proxy/provider 接口是可选替代方案；Loom 已有 Chat 配置与 pi-ai 链路，不需要为追求全量再引入第二个请求路径。见 [vendor index.ts](../packages/agent/vendor-pi-agent/src/index.ts#L149-L152)。

## 待定产品选择

- Harness 可以提供底层 API，但 Skills UI 并非自动获得。其后的 TODO 是素材引用和 Skills。模板不加入产品。运行中 Enter 排队为 followUp，一次插入一条，插入后离开队列并出现在对话里，Stop 丢掉尚未插入的队列。
- 是否在迁移时提供任何权限审批、路径限制或隔离？Harness 默认没有这些安全策略；不能把使用其工具误认为已完成沙箱。见 [tools/path-utils.ts](../packages/agent/vendor-pi-agent/src/harness/tools/path-utils.ts#L13-L15)。
