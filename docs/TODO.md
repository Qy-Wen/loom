# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.md)，Agent 方案见 [AGENT.md](./AGENT.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：Electron 外壳 + agent 对话闭环

跑通「UI 输入 → agent → 大模型 → 流式回显」。只要对话闭环，DB/library/三栏 UI 全部后置。

- [x] 加 `@loom/app`（Electron 外壳：main + preload + renderer，最小窗口）
- [x] main 进程起 localhost HTTP server（`listen(0, 127.0.0.1)` 随机端口，`will-quit` 关）
- [x] server 挂 CopilotKit runtime 端点 + `AgUiAdapter`（`LoomAgentEvent` → AG-UI）
- [x] `AgUiAdapter` 接 `@loom/agent`（DeepSeek），暂无工具
- [x] 实际端口经 preload/IPC 注入 renderer
- [x] renderer 暂时用 CopilotKit 现成聊天框（`@copilotkit/react-core/v2` 的 `CopilotChat`），连 `runtimeUrl`
- [x] typecheck / build / 启动全通，AG-UI 事件流跑通（`RUN_STARTED → TEXT_* → RUN_FINISHED`）

## 第二步：三层解耦 + 库骨架

立起三层架子与库扫描（内存 stub）。

- [ ] 三层解耦：Renderer / Main / LocalCore + 类型化 IPC（Renderer 不碰 DB）
- [ ] `MetadataStore` / `GraphStore` 接口，先用内存 stub
- [ ] Library / LibraryPaths / LibraryWatcher（chokidar，忽略 `.loom/`）
- [ ] React 三栏 UI 骨架（File Tree / Preview / Properties + 底部 Agent 栏）

## 第三步：SQLite MetadataStore + 打通主链路

用 better-sqlite3 实现 `MetadataStore`，打通「选文件夹 → 索引 → 列表/预览」。

- [ ] 建表：`assets`、`properties`、`asset_properties`；增删改查（upsert/get/remove/list）
- [ ] 数据库文件落在库根目录的 `.loom/metadata.db`
- [ ] 原生文件夹选择 → 扫描写入 SQLite → 左侧列表，中间区预览；watcher 实时更新

---

已完成的步骤存档见 [archive/](./archive/)。

---

## 后续（概述）

- **自定义属性**：用户创建属性字段并赋值，新增 Table 视图（排序/过滤）
- **检索**：FTS 全文检索 + sqlite-vec 向量检索 + 属性过滤，融合成 Hybrid Search
- **富化**：ffprobe/exif/文本提取（本地），Embedding 与 VLM 语义分析（可选、按需）
- **前端协议扩展**：AgUiAdapter 补 thinking / 工具富输出（`STATE_DELTA`/`CUSTOM`），见 AGENT.md
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
