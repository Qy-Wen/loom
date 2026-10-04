[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，[Pi Harness 接入范围](./PI-HARNESS.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

提示词模板暂不因 vendor 提供 API 就强行加入产品。已完成的步骤见 [归档](./archive/ARCHIVE.zh-CN.md)。

## 第一步：Human in the loop

高风险操作执行前，由用户确认。

- [ ] 高风险工具调用先暂停，等用户批准或拒绝
- [ ] 展示将要执行的内容，同一轮里恢复或跳过该调用

---

## 后续（概述）

- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **专用 ASR：** OpenAI 兼容 `POST /v1/audio/transcriptions`。优先 Audio 理解槽位。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **多 Agent：** 按真实创作角色拆分协作与编排。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **LangGraph：** 在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **沙箱：** 工作区工具的路径 jail，以及高风险工具和生成任务的进程隔离。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **发布：** 小红书/抖音等平台适配
