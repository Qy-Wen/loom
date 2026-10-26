[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./agent/AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。
> 已完成事项见[归档](./archive/ARCHIVE.zh-CN.md)；已失效、待删除的残留见[待整理](./CLEANUP.zh-CN.md)。

---

## 当前：Chat 回归与交付

剩余验收清单见 [CHAT_MODELS](./agent/CHAT_MODELS.zh-CN.md) P4/P5：

- 切模型后的图片能力提示。
- OpenAI/Anthropic/Google 原生服务与真实 OAuth 登录/刷新/注销验收，交互登录与注销竞态测试。
- 补齐四种协议的工具调用、usage、取消，以及跨协议/Provider 历史转换的完整回归矩阵。
- macOS 实机复测，以及 macOS/Windows 安装包运行验收。

---

## 素材库目录调整

设计见 [LIBRARY_LAYOUT](./LIBRARY_LAYOUT.zh-CN.md)。代码落地后，在 macOS 和 Windows 上手动验证：

- 开启进程沙盒时，调色预览正常：图片和视频都能让 ffmpeg 往 `os.tmpdir()` 下的 `loom-grade-*` 目录写 jpg。
- 关闭素材库或退出应用会删除这个目录；崩溃也不会在素材库里留下文件。
- 新建素材库会创建 `.loom/metadata-db/`、`.loom/graph-db/`、`.loom/grades/`、`.loom/agents/`，根目录除用户文件外没有别的东西。
- 聊天历史、技能、记忆、记住的命令和调色记录都能从新路径正常工作；`.loom/` 里的内容不被索引成素材。

---

## 评测集优化

- 优化评测集，引入真实任务评测：用真实创作任务替换、扩充 `tasks.ts` 的简单金标，覆盖多步工具、媒体产出与失败路径。见 [EVALS](./agent/EVALS.zh-CN.md)。

---

## 第一步：LangGraph

在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

---

## 第二步：深化记忆

`MEMORY.md` 只做索引。条目正文另存。可考虑做梦机制，在空闲时整理、合并和遗忘。

---

## 第三步：多 Tab 查看素材

考虑支持通过多个 Tab 查看素材。
