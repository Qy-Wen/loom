# 已归档

已完成的步骤存档。当前待办见 [../TODO.md](../TODO.md)。

---

## ✅ vendor pi-agent，纯 Node 跑通一轮 agent loop

源码级引入 pi 的 agent 引擎，喂一句话跑通一轮 tool calling（不碰 Electron / UI / DB）。

- pnpm workspace，`@loom/agent` 一个包；`vendor-pi-agent/` + `sync.sh` 同步 pi `packages/agent` @ `v0.85.1`
- npm 装 `@earendil-works/{pi-ai,chord,pi-telemetry}` + `diff`/`ignore`/`typebox`/`yaml`（对齐 0.85.1）
- `tsconfig.base.json` 对齐 pi 编译开关；vendor 引用用 node `imports` 字段 `#vendor/pi-agent`
- `src/{types.ts, pi-adapter.ts}`：`LoomAgent` 接口 + 唯一 vendor 入口；`scripts/try-agent.ts` 冒烟测试
- 跑通 `agent_start → tool_start → tool_end → text → agent_end`；vendor 同步走 `vendor-clean` 分支 + `git merge`
- 实测：DeepSeek 模型 id 是 `deepseek-v4-flash`（provider `deepseek`，读 `DEEPSEEK_API_KEY`）

---

## ✅ Electron 外壳 + agent 对话闭环

跑通「UI 输入 → agent → 大模型 → 流式回显」，暂不引入 DB / library。

- 新增 `@loom/app`：Electron main / preload / React renderer
- main 进程在 `127.0.0.1` 随机端口启动 CopilotKit Runtime，退出时关闭
- `LoomAgUiAgent` 将 `LoomAgentEvent` 翻译成 AG-UI 事件
- runtime endpoint 和 agent id 经类型化 IPC 注入 renderer
- renderer 使用 `@copilotkit/react-core/v2` 的 `CopilotKitProvider` + `CopilotChat`
- 跑通 `RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED`，typecheck / build / 启动通过
