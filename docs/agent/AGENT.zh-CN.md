[English](./AGENT.md) | **简体中文**

# Agent 技术方案

Loom 的创作素材 Agent 使用源码级 vendor 的 `pi-durable`。模型接入使用 npm `pi-ai`，前端协议是 AG-UI。参见 [MIGRATION](./MIGRATION.zh-CN.md)、[EVALS](./EVALS.zh-CN.md)、[MEMORY](./MEMORY.zh-CN.md)、[PERMISSION](./PERMISSION.zh-CN.md)。

## 1. 边界

```
Renderer：CopilotChat + Loom 会话/工具视图
    │ IPC（纯 DTO）/ localhost HTTP SSE（AG-UI）
Main：LibraryAgentHost + DurableAgentRunner + LoomAgUiAgent
    │ @loom/agent
Loom：LibraryAgent + extensions/documents/tool adapters
    │ durable-adapter.ts
Vendor：pi-durable + pi-codemode
    │ pi-ai models / chord / node:sqlite
```

- `packages/agent/src/durable-adapter.ts` 是唯一 vendor import 边界。`@loom/agent` 与 `@loom/agent/durable` 转发原生句柄，增加 Loom 装配和策略。
- Main 持有 `Harness`、`Registry`、`Conversation`。IPC 使用 `LoomSessionRecord` / `LoomSessionSummary`，ID 是十进制字符串；Renderer 不持有 durable 句柄。
- 调度、inbox、重试、压缩、任务取消和恢复属于 durable。Loom 不重建 lane 或旧 session manager。
- 检索与索引仍使用 `packages/core` 的独立存储。

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

- `LibraryAgent.open(root, options, context)` 用 `node:sqlite` 打开 `<library>/.loom/loom.sqlite`，创建一个 Harness 和 Registry。关闭委派 durable，未完成任务保留为可恢复状态。
- Canonical path 预留防止同进程重复 owner；Electron 使用应用单实例锁。其他程序不得同时作为第二个活跃 owner 打开同一存储。WAL 不等于 owner 协调；Windows 运行时仍待实机验证。
- `LibraryAgentHost` 先安装资源、清理过期审批、记录 usage 基线，再调用原生 `resume()`。
- 新独立会话使用库 cwd 和当前 Chat/instructions 默认值。fork 保留 as-of agent 配置。修改模型/指令时 configure 现有会话并更新后续默认值；工具通过 registry extension 原地替换。
- `LoomConversationDoc` 保存最新 title/archive/hidden/创建时间，不进入模型上下文。fork 标题追加 `（分支）`，清除 archive/hidden，不改变来源。
- 聊天 DTO 使用原生 `conversation.entries()` 分页读取 fork-aware 完整历史，不使用压缩后的 `context().entries`；压缩摘要不充当用户消息。列表和记录的更新时间取最后一条非 system/compaction 消息。
- fork-before 从完整历史取目标之前的 entry，首个问题使用初始 anchor，被压缩的旧消息也可分叉。branch-before 创建 fork 并归档来源。删除只隐藏，保留祖先历史和已写入的文件。
- 旧 `.loom/harness-sessions/` JSONL 直接忽略，不迁移。

## 4. 工具、specialist 与 prompt

- `createWorkspaceTools()` 返回 durable `read`、`bash`、`edit`、`write`。env/cwd 按会话构建，bash preparation 接 core 进程沙箱；图像使用上游 Photon worker。
- `toDurableTool()` 把 Loom `content` 转成 durable `output`，传递取消信号、验证 JSON `details`，外部副作用采用 `replay: "unsafe"`。
- 主对话保留工作区、FFmpeg、describe/embed 等应用工具。检索专职使用 `search_assets`、`inspect_asset`、`read`；任务给出 ID 时先 inspect，不再 search 同一素材；需要源文本时 read 返回的 `relativePath`。父代理需传递素材 ID。创作专职使用 MCP `server__tool`、`write`、`bash`。
- 每次 specialist 调用创建一个归属工具任务的前台 conversation。独立调用并行；子代理只见任务和专职 prompt，不能再派生 specialist。父代理只收到摘要，不收到子 transcript。Stop 沿 ownership 取消；request ID 让安全重放复用子会话和 submission。
- `createLibraryExtension()` 装配工具及 preamble/skills/memory sections。用户指令使用原生 `agent.instructions`。
- Skills 在准备请求时通过 durable `ExecutionEnv` 扫描 `.agents/skills/`；遵循作用域 ignore、诊断非法/重复元数据，跳过符号链接。目录只含名称/说明/位置，不含正文；模型按需 `read`。`disable-model-invocation` 从目录中隐藏技能。
- Memory 使用创建时的 `LoomMemoryDoc` 快照，fork/重开保留。`auto_memory` 立即写 `.agents/memory/MEMORY.md`，只影响以后新会话的 prompt。specialist 不选这个 extension。见 [MEMORY](./MEMORY.zh-CN.md)。
- 权限使用可取消的 `ToolTask.beforeTool` hook 和 `LoomApprovalsDoc`，app 观察 pending rows。记住命令与沙箱策略见 [PERMISSION](./PERMISSION.zh-CN.md)。

## 5. 发送时上下文

放进输入框的文件成为 user text 的 `<asset_ref>`；隐式选区成为文字之后 `<system-reminder>` 中的 `<ui_selection>`。**submit 前折叠一次**，持久化后的 model content 不再改写；不需要 attachments 旁路字段或请求时转换。

`loom.user` entry data 保存展示文字，气泡不显示隐式提醒；图片是 model image content。重复选区从已折叠内容识别，旧消息不改写。asset ref 复制稳定 ID 与库内相对路径，点击先按 ID 找当前素材，再回退到路径。

## 6. AG-UI 与实时显示

`LoomAgUiAgent` 继承 `AbstractAgent`；clone 保留 host 和共享运行生命周期。`watchEvents` 的原子 `stream.snapshot` 与后续 commit batch 分开提供，两者都需消费。

| Durable / Loom 状态 | AG-UI |
|---|---|
| Input submission / settlement | `RUN_STARTED`、`RUN_FINISHED` / `RUN_ERROR` |
| `message_start`、`message_update` | text/reasoning 增量 |
| 已提交 entry | `loom.user_entry`、`loom.adopt_entry` |
| `tool_execution_*` | 工具 start/args/end/result、progress activity |
| 审批 document | `loom.tool_gate` activity |
| 工具 details | `loom.tool_result` custom event |
| 重试 / 压缩 | retry activity / compaction custom event |
| 挂载 / 完成 | messages snapshot |

Partial 不只有字符串 delta，还有完整消息和完整内容块。按 block 维护 partial state，只发送尚未显示的 text/thinking 后缀。初始快照在 admission 前保留 optimistic user row，否则前端 history/live 合并会隐藏实时 continuation。工具 call ID 在实时事件和已保存 DTO 中都加 conversation 命名空间。

CopilotChat 显式接收 `threadId`，使用原生重连，不再手动抢占随机 agent thread。子工具等待审批时刷新，卡片和 pending 状态会恢复。从持久化 specialist details 挂载子工具/审批 watcher，并从 snapshot 恢复。子文字不进入父模型历史。follow-up 使用原生 `whenBusy: "followUp"`；Stop 丢弃未接纳输入并取消归属前台工作。

`DurableAgentRunner` 把 run/connect/stop 路由到 adapter 与原生 submission，不使用 CopilotKit 内存历史。传输断开只停止 connect watcher，不取消 durable 工作；显式 Stop 取消匹配的运行。Connect 从 durable snapshot 恢复 partial、工具和子审批，聊天历史由完整 entries 提供，包含主进程崩溃后重开。已完成 submission 重连不等待新的 run-end，即使 answer 已被压缩。

SIGKILL 后流式请求按已提交 checkpoint 重发；中断 partial 保留为 `aborted` 历史，不进入重发的模型上下文。执行中的 unsafe 工具不重放，返回“可能已部分执行”；操作系统子进程可能独立存活，不承诺外部副作用 exactly-once。

Main 的 HTTP 绑定 `127.0.0.1` 随机端口，只允许 Electron/本地 renderer origin，退出时关闭。边界上只有 AG-UI。telemetry producer 留待后续，dev-trace 保留类型和界面但无 span。

上下文圆环显示当前模型窗口的估算占用，点击查看 `~百分比 / 窗口`。`contextUsage()` 使用原生活动 `ContextView`，取当前 provider/model、最新 head 之后的有效 assistant usage（含 cache 与输出），再加后续消息估算。新会话、压缩或模型变化后没有适用 usage 时估算活动消息，含 system/tool schema/图像；不使用完整聊天历史或累计消耗。消息提交、压缩和模型设置变化触发刷新；未配置 Chat 时隐藏。模型窗口取设置值，未填默认 128k，数值并非 tokenizer 精确测量。

## 7. 验证

Agent/app 类型检查和单元测试通过；vendor 源码与编译后 worker 检查通过。Electron 验收覆盖持久化、子代理审批、压缩后 reload/旧消息 fork，以及审批、流式生成和外部 bash 执行中 SIGKILL/重开；验证用户输入不重复、unsafe 工具不重放，以及模型结束**之前**已显示文字。可选真实模型验收：

```bash
cd packages/app
LOOM_E2E_LIVE_CHAT=1 node --env-file=../../.env node_modules/@playwright/test/cli.js test live-chat.spec.ts
```

DeepSeek 的真实流式显示、压缩后锚点回忆及 prompt-cache 评测通过。对齐 retrieve 提示和 inspect mock 的产品字段后，严格 live 工具金标连续两次 4/4，未放宽金标。Windows 实机和受控新旧评测对比仍未完成，不宣称完整能力等价。结果和限制见 [EVALS](./EVALS.zh-CN.md)。
