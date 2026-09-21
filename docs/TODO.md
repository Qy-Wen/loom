# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.md)，Agent 方案见 [AGENT.md](./AGENT.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：三层解耦 + 库骨架

立起三层架子与库扫描（内存 stub）。

- [x] 三层解耦：Renderer / Main / LocalCore + 类型化 IPC（Renderer 不碰 DB）
- [x] `MetadataStore` / `GraphStore` 接口，先用内存 stub
- [x] Library / LibraryPaths / LibraryWatcher（chokidar，忽略 `.loom/`）
- [x] 原生文件夹选择 → 扫描写入内存 Store → watcher 实时更新
- [x] React 三栏 UI 骨架（Asset Library / Workbench / Agent 与 Details）

## 第二步：SQLite MetadataStore + 打通主链路

用 better-sqlite3 实现 `MetadataStore`，打通「选文件夹 → 索引 → 列表/预览」。

- [ ] 建表：`assets`、`properties`、`asset_properties`；增删改查（upsert/get/remove/list）
- [ ] 数据库文件落在库根目录的 `.loom/metadata.db`
- [ ] 将现有「选择文件夹 → 扫描 → 列表」链路切换到 SQLite，watcher 实时更新

## 第三步：自定义属性 + Table 视图

让用户能够为资产维护结构化属性，并以表格方式浏览和筛选。

- [ ] 自定义属性字段的创建、修改与删除
- [ ] 为资产设置属性值
- [ ] Table 视图支持排序与过滤

---

已完成的步骤存档见 [archive/](./archive/)。

---

## 后续（概述）

- **检索**：FTS 全文检索 + sqlite-vec 向量检索 + 属性过滤，融合成 Hybrid Search
- **富化**：ffprobe/exif/文本提取（本地），Embedding 与 VLM 语义分析（可选、按需）
- **前端协议扩展**：AgUiAdapter 补 thinking / 工具富输出（`STATE_DELTA`/`CUSTOM`），见 AGENT.md
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
