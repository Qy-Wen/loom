[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：Hybrid Search

建立统一的资产搜索入口，组合全文、向量和结构化属性过滤。

- [ ] SQLite FTS 全文检索
- [ ] sqlite-vec 向量检索
- [ ] Metadata Filter 属性过滤
- [ ] 融合为统一的 `search_assets` / `hybrid_search` 接口
- [ ] 建立最小检索评测集

## 第二步：本地资产富化

补齐不依赖 AI 的本地媒体信息，为搜索和后续语义分析打基础。

- [ ] 富化任务状态与版本记录
- [ ] 图片 EXIF、尺寸与基础信息提取
- [ ] 音视频 ffprobe：时长、分辨率、编码等
- [ ] 常见文本内容提取并写入 FTS
- [ ] 文件变化后只重算失效的富化结果

## 第三步：Agent 资产工具

将素材库接入 Agent，使其能够检索和查看真实的本地资产。

- [ ] 增加 `search_assets`，支持结构化过滤并返回稳定 asset ID
- [ ] 增加 `inspect_asset`，返回元数据、属性与预览引用
- [ ] 通过 `@loom/agent` 注册工具，不向模型暴露文件系统路径
- [ ] 将工具结果映射为 AG-UI 富输出并交给工作台渲染
- [ ] 增加工具调用与权限回归测试

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **AI 富化**：Embedding 与 VLM 语义分析（可选、按需）
- **前端协议扩展**：AgUiAdapter 补 thinking 与其他工具进度富事件，见 AGENT.md
- **工具**：FFmpeg 媒体处理工具集
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
