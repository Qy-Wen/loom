[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 第一步：LangGraph

在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

---

## 第二步：按图检索

检索沿关系走图，搜索和回答把相连的文件一起带出来。

---

## 第三步：发布

小红书、抖音等平台适配。

---

## 第四步：打包

考虑做成可安装的包，覆盖 macOS 和 Windows。

---

## 第五步：深化记忆

`MEMORY.md` 只做索引。条目正文另存。可考虑做梦机制，在空闲时整理、合并和遗忘。

---

## 第六步：细化权限管理

用户同意某个操作时，可以选择以后这个命令都允许，不再询问。选择 Full 时再确认一次，提示将关闭沙箱，并赋予 Agent 执行所有操作的权限。
