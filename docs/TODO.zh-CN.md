[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：自定义属性 + Table 视图

让用户能够为资产维护结构化属性，并以表格方式浏览和筛选。

- [ ] 建表：`properties`、`asset_properties`
- [ ] 扩展 MetadataStore：属性字段与属性值的增删改查
- [ ] Details 面板支持查看和编辑资产属性
- [ ] Table 视图支持排序与过滤

## 第二步：Hybrid Search

建立统一的资产搜索入口，组合全文、向量和结构化属性过滤。

- [ ] SQLite FTS 全文检索
- [ ] sqlite-vec 向量检索
- [ ] Metadata Filter 属性过滤
- [ ] 融合为统一的 `search_assets` / `hybrid_search` 接口
- [ ] 建立最小检索评测集

## 第三步：本地资产富化

补齐不依赖 AI 的本地媒体信息，为搜索和后续语义分析打基础。

- [ ] 富化任务状态与版本记录
- [ ] 图片 EXIF、尺寸与基础信息提取
- [ ] 音视频 ffprobe：时长、分辨率、编码等
- [ ] 常见文本内容提取并写入 FTS
- [ ] 文件变化后只重算失效的富化结果

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **AI 富化**：Embedding 与 VLM 语义分析（可选、按需）
- **前端协议扩展**：AgUiAdapter 补 thinking / 工具富输出（`STATE_DELTA`/`CUSTOM`），见 AGENT.md
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
