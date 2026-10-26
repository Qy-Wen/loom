[English](./AGENT.md) | **简体中文**

# Agent 技术方案

Loom 的创作素材 Agent 使用源码级 vendor 的 `pi-durable`。模型接入使用 npm `pi-ai`，前端协议是 AG-UI。参见 [MIGRATION](./MIGRATION.zh-CN.md)、[EVALS](./EVALS.zh-CN.md)、[MEMORY](./MEMORY.zh-CN.md)、[PERMISSION](./PERMISSION.zh-CN.md)。

Chat 的 Provider/目录/鉴权、服务商登录和每条对话独立选择模型均已接入生产运行时，见 [CHAT_MODELS](./CHAT_MODELS.zh-CN.md)。

## 1. 边界

```
Renderer：CopilotChat + Loom 会话/工具视图
    │ IPC（纯 DTO）/ localhost HTTP SSE（AG-UI）
Main：ChatService + DurableAgentRunner + AgUiAdapter
    │ @loom/agent
Loom：LibraryRuntime + extensions/documents/tool adapters
    │ durable-adapter.ts
Vendor：pi-durable + pi-codemode
    │ pi-ai models / chord / node:sqlite
```

- `packages/agent/src/durable-adapter.ts` 是唯一 vendor import 边界。`@loom/agent` 与 `@loom/agent/durable` 转发原生句柄，增加 Loom 装配和策略。
- Main 持有 `Harness`、`Registry`、`Conversation`。IPC 使用 `LoomSessionRecord` / `LoomSessionSummary`，ID 是十进制字符串；Renderer 不持有 durable 句柄。
- 调度、inbox、重试、压缩、任务取消和恢复属于 durable。Loom 不重建 lane 或旧 session manager。
- 检索与索引仍使用 `packages/core` 的独立存储。

`LibraryRuntime` 持有一个素材库的 Harness、Registry 和存储。应用级 `ChatService` 打开/关闭运行时，并负责消息准备与提交、权限、默认配置、历史 DTO 和变更通知。`AgUiAdapter` 与 `DurableAgentRunner` 通过服务处理前端协议和连接生命周期。切换素材库后，旧连接仍绑定原运行时。应用与无界面评测通过 `createChatExtensions()` 共用主对话和子代理的扩展组装。

`packages/agent/src` 按职责组织：

| 职责 | 模块 |
|---|---|
| 原生边界与模型配置 | `index`、`durable`、`durable-adapter`、`chat-provider` |
| 库级 owner 与会话元数据 | `library-runtime`、`conversation-metadata`、`session-title` |
| 工具、specialist、权限 | `pi-tools`、`chat-extensions`、`specialist`、`tool-gate`、`tool-permission`、`workspace-path` |
| Prompt sections | `library-extension`、`library-auto-memory`、`library-skills` |
| 输入框与发送时上下文 | `attachments`、`composer-asset`、`composer-image` |
| 契约与上下文占用 | `types`、`session-dto`、`context-usage` |
| 诊断 | `durable-trace`、`trace-models`、`trace-privacy`、`trace-store`、`trace-types` |

运行时调度留在 durable。指令使用原生配置，附件在 submit 前折叠，memory/skills 使用 section；不保留重复的请求时转换、prompt 拼接包装或旧 telemetry recorder。

## 2. Vendor 工作流

`vendor-pi-durable/src` 与 `vendor-pi-codemode/src` 从上游 `main` 的同一 commit 镜像，各自 `UPSTREAM` 记录来源。模型/运行时依赖仍走 npm；codemode 是保留上游 imports 的私有 workspace。

```bash
git checkout vendor-clean
pnpm vendor:sync                 # 可指定 ref
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi durable main"
git checkout main
git merge vendor-clean
```

同步只能在 `vendor-clean` 上运行，从一份临时 clone 同步两包，排除测试/testing/benchmark，支持 macOS 和原生 Windows。Loom 自有代码放在两份 vendor `src/` 之外；集成不改上游源码。

## 3. 库级 owner 与持久化

- `LibraryRuntime.open(root, options, context)` 用 `node:sqlite` 打开 `<library>/.loom/agents/sessions/loom.sqlite`，创建一个 Harness 和 Registry。关闭委派 durable，未完成任务保留为可恢复状态。
- Canonical path 预留防止同进程重复 owner；Electron 使用应用单实例锁。其他程序不得同时作为第二个活跃 owner 打开同一存储。WAL 不等于 owner 协调；Windows 运行时仍待实机验证。
- `ChatService` 先安装资源、清理过期审批、记录 usage 基线，再调用原生 `resume()`。
- 新独立会话使用库 cwd 和当前 Chat/instructions 默认值。模型默认值也用于补齐未选模型的会话，已保存的选择不变；会话可在输入区切换模型与思考强度，忙碌时拒绝切换。fork 保留 as-of agent 配置。常驻指令更新现有会话及后续默认值；工具通过 registry extension 原地替换。
- `LoomConversationDoc` 保存最新 title/archive/hidden/创建时间，不进入模型上下文。fork 标题追加 `（分支）`，清除 archive/hidden，不改变来源。
- Loom 元数据、审批和冻结的 memory 使用 `history: "latest"`，每次普通变更保存完整快照；SQLite 会清理这些当前状态文档的旧存储版本。
- 聊天 DTO 使用原生 `conversation.entries()` 分页读取 fork-aware 完整历史，不使用压缩后的 `context().entries`；压缩摘要不充当用户消息。列表和记录的更新时间取最后一条非 system/compaction 消息。
- fork-before 从完整历史取目标之前的 entry，首个问题使用初始 anchor，被压缩的旧消息也可分叉。branch-before 创建 fork 并归档来源。关闭空会话（无聊天消息或待处理输入）直接隐藏，不进入历史；有消息的会话仍归档。内部起始/system 记录不算聊天，fork 继承的消息算。删除只隐藏，保留祖先历史和已写入的文件。
- `.loom/` 下的旧目录一律忽略，不读取也不删除。

## 4. 工具、specialist 与 prompt

- `createWorkspaceTools()` 返回 durable `read`、`bash`、`edit`、`write`。env/cwd 按会话构建，bash preparation 接 core 进程沙箱；图像使用上游 Photon worker。
- `toDurableTool()` 把 Loom `content` 转成 durable `output`，传递取消信号、验证 JSON `details`，外部副作用采用 `replay: "unsafe"`。
- 主对话保留工作区、FFmpeg、describe/embed 等应用工具，以及所有已连接的 MCP 工具。主对话和检索专职共享 `search_assets`、`inspect_asset`，检索专职还有 `read`；任务给出 ID 时先 inspect，不再 search 同一素材；需要源文本时 read 返回的 `relativePath`。主 Agent 直接完成单项检索，包括多步任务；只有多项独立、可并行的检索任务才考虑委托检索专职，并传递各自的问题和所需素材 ID。创作专职使用 `read`、`edit`、`write`、`bash`、`inspect_asset`、FFmpeg 媒体工具和与主对话相同的 MCP 工具；没有 `search_assets`、describe/embed、属性、关系和设置工具。主 Agent 按任务选择直接调用 MCP 或委托创作专职。所有 Agent 经过同一道审批门；检索专职不接入 MCP。
- 每次 specialist 调用创建一个归属工具任务的前台 conversation。独立调用并行；子代理只见任务和专职 prompt，不能再派生 specialist。父代理只收到摘要，不收到子 transcript。Stop 沿 ownership 取消；request ID 让安全重放复用子会话和 submission。
- `createLibraryExtension()` 装配工具及 preamble/skills/memory sections。用户指令使用原生 `agent.instructions`。
- Skills 在准备请求时通过 durable `ExecutionEnv` 扫描 `.loom/agents/skills/`；遵循作用域 ignore、诊断非法/重复元数据，跳过符号链接。目录只含名称/说明/位置，不含正文；模型按需 `read`。`disable-model-invocation` 从目录中隐藏技能。
- Memory 使用创建时的 `LoomMemoryDoc` 快照，fork/重开保留。`auto_memory` 立即写 `.loom/agents/memory/MEMORY.md`，只影响以后新会话的 prompt。specialist 不选这个 extension。见 [MEMORY](./MEMORY.zh-CN.md)。
- 权限使用可取消的 `ToolTask.beforeTool` hook 和 `LoomApprovalsDoc`，app 观察 pending rows。记住命令与沙箱策略见 [PERMISSION](./PERMISSION.zh-CN.md)。

## 5. 发送时上下文

放进输入框的文件成为 user text 的 `<asset_ref>`；隐式选区成为文字之后 `<system-reminder>` 中的 `<ui_selection>`。**submit 前折叠一次**，持久化后的 model content 不再改写；不需要 attachments 旁路字段或请求时转换。

普通消息与排队追加共用 `ChatService.prepareTurn()`，消费暂存输入、折叠上下文、检查空输入并初始化标题。传输层观察器接好之后才提交。重放已有 request 时复用原 submission，不消费下一份草稿。

`loom.user` entry data 保存展示文字，气泡不显示隐式提醒。显式添加的 JPEG/PNG/GIF/WebP 芯片还会把图片内容附到普通消息和排队追加消息里（最多 4 张，每张 8 MiB），发送前按素材 ID 读取库内当前文件。其他图片格式保留为引用；纯文字模型收到 pi-ai 的图片省略占位文字。没有磁盘路径的剪贴板截图先导入 `Inbox/`，再成为芯片。移除芯片也会移除下一条消息里的对应图片。重复选区从已折叠内容识别，旧消息不改写。asset ref 复制稳定 ID 与库内相对路径，点击先按 ID 找当前素材，再回退到路径。

MCP 使用官方 SDK，读完全部工具分页后统一缓存输出 schema 和任务要求。内嵌文本/图片资源先展开；`content` 为空时，`structuredContent` 转成 JSON 文本，已有内容优先于结构化回退。结果再交给应用工具共用的 `toDurableTool()`：文字和图片保留为原生结果，其他内容块转为 JSON 文字。MCP 的 `isError` 使用可读文本报告工具失败；取消传到服务端，迟到结果会被丢弃。

Durable 统一限制结果文字（2,000 行 / 50 KiB）；图片没有通用大小上限。不增加 MCP 专用的媒体处理、截断或文件缓存。原始图片保留在 durable 历史中供模型使用。UI 的历史记录和实时工具结果只携带 `loom-asset://chat-image/<conversation>/<entry>/<contentIndex>` 引用，工具卡片按需加载字节；不把 base64 搬进 IPC/SSE。纯文字工具结果沿用原有表示。

主 Agent 和专职 Agent 共用 `createToolResultStorage()`，在 durable 最终截断前通过 `afterTool` 保存超过 50 KiB 或 2,000 行的完整文字，路径为 `.loom/agents/tool-results/<conversationId>/<taskId>.txt`。模型收到最多 2 KiB、UTF-8 安全的预览、完整路径和分段读取提示；图片、错误状态、UI details 和结构化结果不变。`read` 和已有 `full_output` 提示的结果不重复落盘。写入失败会警告并沿用 durable 截断。文件在重开和分支后仍保留，不自动过期；`.agents` 不作为素材索引。进入钩子前已被流式缓冲丢弃的文字无法恢复；shell 工具沿用现有落盘机制。

## 6. AG-UI 与实时显示

`AgUiAdapter` 继承 `AbstractAgent`；clone 保留聊天服务和共享连接生命周期。`ag-ui-events.ts` 独立转换 durable 事件，处理文字/思考增量、子对话工具和审批，不负责提交或订阅管理。`watchEvents` 的原子 `stream.snapshot` 与后续 commit batch 分开提供，两者都需消费。

| Durable / Loom 状态 | AG-UI |
|---|---|
| Input submission / settlement | `RUN_STARTED`、`RUN_FINISHED` / `RUN_ERROR` |
| `message_start`、`message_update` | text/reasoning 增量 |
| 已提交 entry | `loom.user_entry`、`loom.adopt_entry` |
| `tool_execution_*` | 工具 start/args/end/result、progress activity |
| 审批 document | `loom.tool_gate` activity |
| 工具 details | `loom.tool_result` custom event |
| 重试 / 压缩 | retry activity / compaction custom event |
| 挂载 / 重连 | 仅当前活动工作与待接纳输入的 snapshot |
| 完成 | `loom.history_changed`，通知读取新增的已保存条目 |

历史与实时状态分开：`useSessions` 首次通过 IPC 加载完整历史，后续按最后一个 entry ID 读取新增条目；同一时刻只保留一次刷新请求，切换会话或素材库会拒绝过期结果。SSE 不发送已保存历史，完成时只发失效通知。发送请求只包含本次 user message，模型上下文由 durable 构建。

Partial 按 block 维护，只发送尚未显示的 text/thinking 后缀。user admission 持久化客户端消息 ID；assistant 提交时同时替换正文和 reasoning ID。历史与实时消息只按 ID 合并，已保存内容为准，同时保留 live specialist 子工具调用；不按文字、数组长度或历史尾部猜测。follow-up 也使用客户端 ID 对齐排队与接纳状态。排队中的 follow-up 可按客户端 ID 撤回（`cancelFollowUp` → `abortSubmission`），进入运行后即成为普通消息，不可再撤回。工具 call ID 始终带 conversation 命名空间。

Renderer 中 `session-chat` 只组装会话与分支操作；`use-sessions` 管理选择和已保存历史，`use-chat-stream` 管理实时消息 ID 和提交边界，`chat-composer` / `chat-composer-input` 管理输入和附件，`chat-messages` / `chat-scroll` 分别管理展示和跟随滚动。

CopilotChat 显式接收 `threadId`，使用原生重连，不再手动抢占随机 agent thread。编辑旧问题先 fork-and-switch，等待新线程连接完成后，通过当前 CopilotChat 发送入口提交一次；不复用旧线程发送回调或强制覆盖实时消息。子工具等待审批时刷新，卡片和 pending 状态会恢复。从持久化 specialist details 挂载子工具/审批 watcher，并从 snapshot 恢复。子文字不进入父模型历史。follow-up 使用原生 `whenBusy: "followUp"`；Stop 丢弃未接纳输入并取消归属前台工作。

`DurableAgentRunner` 把 run/connect/stop 路由到 adapter 与原生 submission，不使用 CopilotKit 内存历史。传输断开只停止 connect watcher，不取消 durable 工作；显式 Stop 取消匹配的运行。Connect 从 durable snapshot 恢复 partial、工具和子审批，聊天历史由完整 entries 提供，包含主进程崩溃后重开。已完成 submission 重连不等待新的 run-end，即使 answer 已被压缩。

SIGKILL 后流式请求按已提交 checkpoint 重发；中断 partial 保留为 `aborted` 历史，不进入重发的模型上下文。执行中的 unsafe 工具不重放，返回“可能已部分执行”；操作系统子进程可能独立存活，不承诺外部副作用 exactly-once。

Main 的 HTTP 绑定 `127.0.0.1` 随机端口，只允许 Electron/本地 renderer origin，退出时关闭。边界上只有 AG-UI。开发 trace 使用 Loom extension/commit 观察器和公开模型调用观察，保存到 `.loom/agents/traces/telemetry.sqlite`；Traces 窗口读取历史和实时 revision。时间、隐私、恢复与验收边界见 [TRACE](./TRACE.zh-CN.md)。

上下文圆环显示当前模型窗口的估算占用，点击查看 `~百分比 / 窗口`。`contextUsage()` 使用原生活动 `ContextView`，取当前 provider/model、最新 head 之后的有效 assistant usage（含 cache 与输出），再加后续消息估算。新会话、压缩或模型变化后没有适用 usage 时估算活动消息，含 system/tool schema/图像；不使用完整聊天历史或累计消耗。消息提交、压缩和模型设置变化触发刷新；未配置 Chat 时隐藏。模型窗口取设置值，未填默认 128k，数值并非 tokenizer 精确测量。

## 7. 验证

Agent/app 类型检查和单元测试通过；vendor 源码与编译后 worker 检查通过。Electron 验收覆盖持久化、子代理审批、压缩后 reload/旧消息 fork，以及审批、流式生成和外部 bash 执行中 SIGKILL/重开；验证用户输入不重复、unsafe 工具不重放，以及模型结束**之前**已显示文字。可选真实模型验收：

```bash
cd packages/app
LOOM_E2E_LIVE_CHAT=1 node --env-file=../../.env node_modules/@playwright/test/cli.js test live-chat.spec.ts
```

DeepSeek 的真实流式显示、压缩后锚点回忆及 prompt-cache 评测通过。对齐 retrieve 提示和 inspect mock 的产品字段后，严格 live 工具金标连续两次 4/4，未放宽金标。Windows 实机和受控新旧评测对比仍未完成，不宣称完整能力等价。结果和限制见 [EVALS](./EVALS.zh-CN.md)。
