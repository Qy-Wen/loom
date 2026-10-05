[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，[Pi Harness 接入范围](./PI-HARNESS.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 第一步：多 Agent

按真实创作角色拆协作，不要上一个泛泛的编排器。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

主对话 Agent 对人、做计划、做变换（FFmpeg）。底下两个专职：

- [x] 检索 Agent：搜库、看素材；只回 `asset_id` 和段落
- [x] 生成 Agent：用一段 brief 走 MCP 生成；不搜库。需要 `asset_id` 时写进 brief
- [x] 第一版就并行：同一轮里互不依赖的调用一起跑（沿用 Harness 已有的并行工具）。子 Agent 不能再派生子 Agent

## 第二步：进程沙箱

高风险工作（bash、FFmpeg、生成任务）和机器其余部分隔开。

- [ ] 隔离这些进程，避免换一条 argv 就碰到不该碰的文件

---

## 后续（概述）

- **可观测性：** 按次的工具 / 耗时 / token 轨迹，用 pi-telemetry（span 已有，目前 no-op）。不要另做一套追踪。累计 Stats 已有。
- **LangGraph：** 在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **发布：** 小红书/抖音等平台适配
