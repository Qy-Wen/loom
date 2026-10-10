[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 第一步：可观测性

一次提问的 run、turn、step、tool、模型请求记在内存里。开发时单独开一个 Traces 窗口看瀑布图。点工具或模型 span 可看参数和返回值，或发给模型的消息和回复。每一边会截断。打包后没有这个窗口。不要另做一套追踪。累计 Stats 已有。

---

## 第二步：LangGraph

在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

---

## 第三步：按图检索

检索沿关系走图，搜索和回答把相连的文件一起带出来。

---

## 第四步：发布

小红书、抖音等平台适配。

---

## 第五步：打包

考虑做成可安装的包，覆盖 macOS 和 Windows。
