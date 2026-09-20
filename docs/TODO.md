# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.md)，Agent 方案见 [AGENT.md](./AGENT.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：搭框架骨架

用 pnpm monorepo 把三层解耦的架子立起来。

- [ ] `@loom/core`（Local Core，框架无关）+ `@loom/app`（Electron 客户端）两个包
- [ ] 三层解耦：Renderer / Main / LocalCore + 类型化 IPC（Renderer 不碰 DB）
- [ ] core 里定好接口：`MetadataStore`、`GraphStore`，先用内存 stub 顶着
- [ ] Library / LibraryPaths / LibraryWatcher（chokidar，忽略 `.loom/`）
- [ ] React 三栏 UI 骨架（File Tree / Preview / Properties + 底部 Agent 栏）
- [ ] typecheck / build 全通过

## 第二步：SQLite MetadataStore

用 better-sqlite3 实现 core 里的 `MetadataStore` 接口，替换内存 stub。

- [ ] 建表：`assets`、`properties`、`asset_properties`
- [ ] 实现增删改查（upsert / get / remove / list）
- [ ] 数据库文件落在库根目录的 `.loom/metadata.db`

## 第三步：打通「选文件夹 → 索引 → 列表/预览」

让整条链路真正跑起来。

- [ ] 用原生文件夹选择对话框替换 `window.prompt`
- [ ] 打开库后扫描文件、写入 SQLite、在左侧列表展示
- [ ] 中间预览区能显示图片/视频/文本
- [ ] watcher 的 add/change/unlink 实时更新列表

---

## 后续（概述）

- **自定义属性**：用户创建属性字段并赋值，新增 Table 视图（排序/过滤）
- **检索**：FTS 全文检索 + sqlite-vec 向量检索 + 属性过滤，融合成 Hybrid Search
- **富化**：ffprobe/exif/文本提取（本地），Embedding 与 VLM 语义分析（可选、按需）
- **Agent**：vendor pi-agent + adapter 解耦，接入 LLM 跑通 tool calling 闭环（见 AGENT.md）
- **前端协议**：AgUiTranslator 把 AgentEvent 翻成 AG-UI（thinking/富输出先留占位）
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
