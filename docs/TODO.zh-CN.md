[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 第一步：记忆

跨会话记住用户偏好和创作约定。见 [MEMORY](./agent/MEMORY.zh-CN.md)。

- [x] 笔记放在当前库的 `.agents/memory/`。打开库时若没有这个目录就建好。不要收成素材。一小段常驻笔记放进系统提示，会话开始时冻结。会话中途写进去的内容立刻留下，下一轮会话再读。只记事实。做法仍写成 skill
- [x] 用一个工具增、改、删。工具结果给出最新内容。系统提示里的那份快照保持不动，直到下一轮会话
- [ ] 按当前这句话检索出来的记忆，接在同一条用户消息里，和库高亮一起放进 `<system-reminder>`。不要第二条用户消息。没选中、也没检索到：不加这段提醒

## 第二步：进程沙箱

高风险工作（bash、FFmpeg、生成任务）和机器其余部分隔开。

- [ ] 隔离这些进程，避免换一条 argv 就碰到不该碰的文件

---

## 后续（概述）

- **可观测性：** 按次的工具 / 耗时 / token 轨迹，用 pi-telemetry（span 已有，目前 no-op）。不要另做一套追踪。累计 Stats 已有。
- **LangGraph：** 在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **发布：** 小红书/抖音等平台适配
