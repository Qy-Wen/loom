[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./agent/AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。
> 已完成事项见[归档](./archive/ARCHIVE.zh-CN.md)。

---

## 当前：Chat 回归与交付

剩余验收：

- OpenAI/Anthropic/Google 原生服务验收，以及真实 OAuth 令牌刷新验收。
- 补齐四种协议的工具调用、usage、取消，以及跨协议/Provider 历史转换的完整回归矩阵。

---

## 评测集优化

- 优化评测集，引入真实任务评测：用真实创作任务替换、扩充 `tasks.ts` 的简单金标，覆盖多步工具、媒体产出与失败路径。见 [EVALS](./agent/EVALS.zh-CN.md)。

---

## 后台切块

把切块与向量拆开，使切块与块级全文在摘录之后后台自动完成，只有向量仍等用户触发。需要先有后台、可取消、让出事件循环的任务机制。现在没做的原因见 [RAG](./RAG/RAG.zh-CN.md#什么时候建索引)。

---

## 拆分入口文件

`app/src/main/index.ts`（约 1500 行）、`app/src/renderer/App.tsx`（约 1350 行）、`core/src/local-core.ts`（约 730 行）集中了多个职责。按职责逐步拆，不要把原文件整体换个名字搬走：

- main 入口：移出素材协议、按功能分组的 IPC 注册和设置协调，入口只保留启动装配与生命周期。
- App：抽出库操作、选区和素材任务状态。
- LocalCore：保留领域入口，把检索、媒体处理等实现归回对应模块。

验收：UI 和工具继续通过同一领域入口工作；无重复业务规则；相关 IPC、桌面流程和领域测试通过。

---

## 第一步：LangGraph

在现有对话 Agent 之外加一条受控流程，用固定步骤执行任务。见 [PRODUCT](./PRODUCT.zh-CN.md) §10。

---

## 第二步：深化记忆

`MEMORY.md` 只做索引。条目正文另存。可考虑做梦机制，在空闲时整理、合并和遗忘。
