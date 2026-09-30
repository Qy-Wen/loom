[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，[Pi Harness 接入范围](./PI-HARNESS.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

自动阈值压缩仍列在后续；提示词模板与插话队列暂不因 vendor 提供 API 就强行加入产品。

## 第一步：从之前的提问分支

基于 harness 会话树，从历史用户提问续聊当前会话或开新会话；不回退 Agent 已经改过的文件。见 [AGENT](./AGENT.zh-CN.md) §6.3d。

- [ ] 续聊：切换当前路径，旧路径留在树中；是否提供切回入口待定
- [ ] 开新会话：复制选中位置的前缀；原会话保持不变
- [ ] 做界面前确定选中问题时是把它留在上下文里，还是放回输入框供编辑
- [ ] 工作区里已经写下的文件保持现状，不做检查点回退

## 第二步：对话资产引用

输入框可贴库内资产（不只是隐式 `ui_selection`）。对话里的 `asset_id` 引用可点并选中该资产。见 [AGENT](./AGENT.zh-CN.md) §5 和 §6.3b。

- [ ] 输入框芯片走 user 的 `attachments` 旁路；折进 Chat 的办法不变
- [ ] 画出这些芯片以及 `search_assets` / `inspect_asset` 的引用；点击后在素材库里选中
- [ ] 用 `asset_id` 当键，不用绝对路径

## 第三步：Skills

把当前素材库里的 `SKILL.md` 接到运行在 pi harness 上的创作 Agent。见 [AGENT](./AGENT.zh-CN.md)。

- [ ] 从素材库读取 Agent Skills（`SKILL.md`，agentskills.io）。不 vendor `packages/coding-agent`
- [ ] 命中的技能正文放进系统提示，或做成 Agent 按需读取的工具

---

## 后续（概述）

- **自动阈值压缩：** 配置真实 Chat 上下文窗口，验证阈值压缩触发时机及摘要对附件语义的保留；不阻塞 Harness 切换。
- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **专用 ASR：** OpenAI 兼容 `POST /v1/audio/transcriptions`。优先 Audio 理解槽位。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **多 Agent：** 按真实创作角色拆分协作与编排。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **沙箱：** 工作区工具的路径 jail，以及高风险工具和生成任务的进程隔离。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。
- **评测：** Agent 行为、工具调用、检索效果。压缩率和 prompt-cache 命中率已在 `packages/agent/evals/`；Hybrid Search 有最小单测集。见 [PRODUCT](./PRODUCT.zh-CN.md) §10 和 [AGENT](./AGENT.zh-CN.md)。
- **发布：** 小红书/抖音等平台适配
