[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./agent/AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。

---

## 当前：Chat 完整接入 pi-ai

已确认范围与分阶段清单见 [CHAT_MODELS](./agent/CHAT_MODELS.zh-CN.md)。原生 Provider/目录、API Key/OAuth 登录、Chat 凭据加密与 Provider/默认值设置 UI 已上线生产；旧端点兼容已移除。应用默认值只影响新会话，其他模型槽位不变。剩余：会话级模型选择（P4）与 Windows/真实 OAuth 回归（P5）。

---

## 第一步：LangGraph

在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

---

## 第二步：发布

小红书、抖音等平台适配。

---

## 第三步：深化记忆

`MEMORY.md` 只做索引。条目正文另存。可考虑做梦机制，在空闲时整理、合并和遗忘。

---

## 第四步：模型配置易用性

Chat 配置已纳入当前的 [pi-ai 接入](./agent/CHAT_MODELS.zh-CN.md)。后续再降低其他模型槽位的配置门槛。

---

## 第五步：多 Tab 查看素材

考虑支持通过多个 Tab 查看素材。
