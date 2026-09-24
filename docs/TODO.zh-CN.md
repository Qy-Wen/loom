[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管的只剩库：检索、FFmpeg、路径狱、入库。

---

## 第一步：MCP 产物入库

MCP server 把文件写在它自己的地方。Loom 只索引当前库，所以 Agent 需要一个第一方入口，把字节或文件落到库里。

- [ ] 第一方工具按相对路径写入当前库（默认 `outputs/`）；绝对路径留在 Main
- [ ] 能收 MCP 返回的字节，或宿主可读的路径；拷进库后交给现有 watcher
- [ ] 不针对 Comfy；任何创作 MCP 共用这一个工具
- [ ] 不上 `generate_image` / `generate_video`，也不写 Comfy HTTP 客户端

## 第二步：产物出处

记下 Agent 产出的文件从哪来。先不上 LadybugDB，也不做 Graph 视图。

- [ ] FFmpeg 封装工具写出产物时记下 `GENERATED_FROM`（或等价边）
- [ ] 入库工具写入 MCP 产物时记同一条边
- [ ] 在 `inspect_asset` 和 Details 里能看到这些边
- [ ] 存储保持薄（SQLite 即可）；graph handlers 可以继续空操作

## 第三步：检索 Level 1 文本

- [ ] 现有 `search_assets` 纳入 `asset_metadata` 摘录
- [ ] 先不上 FTS、向量或 Hybrid Search

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **Hybrid Search：** SQLite FTS、sqlite-vec、融合后的 `hybrid_search`、最小检索评测集——等 Embedding 有数据再做
- **AI 富化：** 按需 Level 2 Embedding 与 VLM 说明/标签；默认不整库富化
- **关系图：** LadybugDB、Graph 视图、手动建关系
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
