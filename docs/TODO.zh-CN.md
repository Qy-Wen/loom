[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

检索回路已完成（Hybrid Search、音频说明、可选 Rerank）。已完成步骤见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 第一步：从之前的提问分支

和分支一起做。从之前某条用户提问续聊当前会话，或开一条新会话，像 Cursor。不必回退 Agent 已经改过的文件。见 [AGENT](./AGENT.zh-CN.md) §6.3d。

- [ ] 续聊：该提问之后的轮次丢掉或收起；模型上下文是到该提问为止的前缀
- [ ] 开新会话：同一前缀；原 transcript 不动
- [ ] 工作区里已经写下的文件保持现状，不做检查点回退
- [ ] 现在存储是线性只追加 JSONL

## 第二步：对话资产引用

输入框可贴库内资产（不只是隐式 `ui_selection`）。对话里的 `asset_id` 引用可点并选中该资产。见 [AGENT](./AGENT.zh-CN.md) §5 和 §6.3b。

- [ ] 输入框芯片走 user 的 `attachments` 旁路；折进 Chat 的办法不变
- [ ] 画出这些芯片以及 `search_assets` / `inspect_asset` 的引用；点击后在素材库里选中
- [ ] 用 `asset_id` 当键，不用绝对路径

## 第三步：Skills

把当前素材库里的 `SKILL.md` 接到创作 Agent。见 [AGENT](./AGENT.zh-CN.md)。

- [ ] 从素材库读取 Agent Skills（`SKILL.md`，agentskills.io）。不 vendor `packages/coding-agent`
- [ ] 命中的技能正文放进系统提示，或做成 Agent 按需读取的工具
- [ ] 继续用现在的 simple Agent，不把运行时换成 pi harness

---

## 后续（概述）

- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **专用 ASR：** OpenAI 兼容 `POST /v1/audio/transcriptions`。优先 Audio 理解槽位。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **多 Agent：** 按真实创作角色拆分协作与编排。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **沙箱：** 工作区工具的路径 jail，以及高风险工具和生成任务的进程隔离。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **评测：** Agent 行为、工具调用、检索效果。压缩率和 prompt-cache 命中率已在 `packages/agent/evals/`；Hybrid Search 有最小单测集。见 [PRODUCT](./PRODUCT.zh-CN.md) §10 和 [AGENT](./AGENT.zh-CN.md)。
- **发布：** 小红书/抖音等平台适配
