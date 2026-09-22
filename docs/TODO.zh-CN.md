[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：本地资产富化

补齐不依赖 AI 的本地媒体信息，为更强的搜索与后续语义分析打基础。

- [ ] 富化任务状态与版本记录
- [ ] 图片 EXIF、尺寸与基础信息提取
- [ ] 音视频 ffprobe：时长、分辨率、编码等
- [ ] 提取常见文本内容，供全文索引使用
- [ ] 文件变化后只重算失效的富化结果

## 第二步：Hybrid Search

将确定性资产搜索升级为词法、向量与结构化过滤融合的统一检索栈。

- [ ] SQLite FTS 全文检索：文件名、路径、属性与提取文本
- [ ] sqlite-vec：对按需富化的资产进行向量检索
- [ ] Metadata Filter：内置字段与自定义属性过滤
- [ ] 在 `search_assets` / `hybrid_search` 后融合检索能力
- [ ] 建立最小检索评测集

## 第三步：FFmpeg Agent 工具

让 Agent 执行确定性的本地媒体操作，并将产物重新索引。

- [ ] 增加媒体信息、抽帧、裁剪片段、缩放、画面裁切和格式转换工具
- [ ] 校验所有 asset ID，并将文件系统路径限制在 Local Core 内部
- [ ] 流式返回工具进度并支持取消
- [ ] 索引生成文件，并把 provenance 关联到源 asset ID
- [ ] 增加基于 fixture 的工具与失败路径测试

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **AI 富化**：Embedding 与 VLM 语义分析（可选、按需）
- **前端协议扩展**：AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
