[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

检索回路已完成（Hybrid Search、音频说明、可选 Rerank）。已完成步骤见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 第一步：停止对话

CopilotChat 的 Stop 必须中止 pi 这一轮和正在跑的工具，不能只退订 UI。见 [AGENT](./AGENT.zh-CN.md) §6.3c。

- [x] AG-UI 退订时调用 `LoomAgent.abort()`
- [x] Chat、bash、FFmpeg、VLM/Audio HTTP、embedding/rerank、MCP 都响应 `AbortSignal`
- [x] 中止的这一轮仍写入 JSONL；Stop 不当成 Chat 报错。FFmpeg 进度以后再说

## 第二步：对话资产引用

输入框可贴库内资产（不只是隐式 `ui_selection`）。对话里的 `asset_id` 引用可点并选中该资产。见 [AGENT](./AGENT.zh-CN.md) §5 和 §6.3b。

- [ ] 输入框芯片走 user 的 `attachments` 旁路；折进 Chat 的办法不变
- [ ] 画出这些芯片以及 `search_assets` / `inspect_asset` 的引用；点击后在素材库里选中
- [ ] 用 `asset_id` 当键，不用绝对路径

## 第三步：从某条消息分支

当前会话可从任意一轮续聊，或用该前缀开新会话。见 [AGENT](./AGENT.zh-CN.md) §6.3d。

- [ ] 续聊：该条之后丢掉或收起；模型上下文是到该条为止的前缀
- [ ] 开新会话：同一前缀；原 transcript 不动
- [ ] 现在存储是线性只追加 JSONL

---

## 后续（概述）

- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **专用 ASR：** OpenAI 兼容 `POST /v1/audio/transcriptions`。优先 Audio 理解槽位。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **Thinking：** 聊天里展示模型推理过程。先在 `LoomAgentEvent` 补 thinking 事件，再映射到 AG-UI `THINKING_*`；丢弃 redacted；`thoughtSignature` 不进前端协议。见 [AGENT](./AGENT.zh-CN.md)。
- **Skills：** 把 Agent Skills（`SKILL.md`，agentskills.io）接到创作 Agent。pi harness 已有这套格式；不 vendor `packages/coding-agent`。见 [AGENT](./AGENT.zh-CN.md)。
- **多 Agent：** 按真实创作角色拆分协作与编排。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **沙箱：** 工作区工具的路径 jail，以及高风险工具和生成任务的进程隔离。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **评测：** Agent 行为、工具调用、检索效果。压缩率和 prompt-cache 命中率已在 `packages/agent/evals/`；Hybrid Search 有最小单测集。见 [PRODUCT](./PRODUCT.zh-CN.md) §10 和 [AGENT](./AGENT.zh-CN.md)。
- **FFmpeg 进度：** 长任务协议层推送进度（杀进程是第一步）
- **发布：** 小红书/抖音等平台适配
