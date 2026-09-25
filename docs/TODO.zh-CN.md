[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

## 第一步：检索 Level 1 文本

- [ ] 现有 `search_assets` 纳入 `asset_metadata` 摘录
- [ ] 先不上 FTS、向量或 Hybrid Search

## 第二步：Hybrid Search

把确定性资产搜索升级为词法、向量与结构化过滤融合的检索栈。

- [ ] SQLite FTS：文件名、路径、属性与提取文本
- [ ] sqlite-vec：对按需富化的资产做向量检索
- [ ] 在 `search_assets` / `hybrid_search` 后融合
- [ ] 建立最小检索评测集

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **AI 富化：** 按需 Level 2 Embedding 与 VLM 说明/标签；默认不整库富化
- **关系图：** Graph 视图、手动建关系（Ladybug 已存 `GENERATED_FROM`）
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
