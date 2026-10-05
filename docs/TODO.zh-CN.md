[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 第一步：进程沙箱

bash 和 FFmpeg 跑在沙箱里。生成任务走 MCP，不套这层。见 [PERMISSION](./AGENT/PERMISSION.zh-CN.md)。

- [x] 隔离 bash 和 FFmpeg，避免换一条 argv 就碰到范围外的文件

---

## 后续（概述）

- **可观测性：** 按次的工具 / 耗时 / token 轨迹，用 pi-telemetry（span 已有，目前 no-op）。不要另做一套追踪。累计 Stats 已有。
- **LangGraph：** 在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **发布：** 小红书/抖音等平台适配
