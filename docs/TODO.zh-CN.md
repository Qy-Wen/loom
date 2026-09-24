[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)。
> 只详细列最近三步，后续只做概述。

---

## 第一步：FFmpeg Agent 工具

让 Agent 直接调用 FFmpeg 做本地媒体处理，并将产物重新索引。

- [x] 封装工具：媒体信息、抽帧、裁剪片段、缩放、画面裁切、格式转换；不够用时用 `run_ffmpeg`
- [x] 工具只收库内相对路径；绝对路径留在 Local Core，禁止出库
- [x] 产物写在库内（默认 `outputs/`，可指定其它相对路径），由现有 watcher 收编

## 第二步：Hybrid Search

将确定性资产搜索升级为词法、向量与结构化过滤融合的统一检索栈。

- [ ] SQLite FTS 全文检索：文件名、路径、属性与提取文本
- [ ] sqlite-vec：对按需富化的资产进行向量检索
- [ ] Metadata Filter：内置字段与自定义属性过滤
- [ ] 在 `search_assets` / `hybrid_search` 后融合检索能力
- [ ] 建立最小检索评测集

## 第三步：AI 富化

在本地技术元数据之上，按需加入 Embedding 与 VLM 分析。

- [ ] 为选定资产持久化 Level 2 Embedding，并接入 Hybrid Search
- [ ] 按需跑 VLM，生成说明、标签或场景描述
- [ ] 在 UI 中跟踪富化任务与可见成本状态
- [ ] AI 工作一律由用户触发，默认不整库富化

---

已完成的步骤存档见 [archive/](./archive/README.zh-CN.md)。

---

## 后续（概述）

- **FFmpeg 进度与取消**：长任务可中断，协议层推送进度（不做也能先跑完）
- **前端协议扩展**：AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **创作**：直连 ComfyUI 生成图片/视频
- **关系图**：LadybugDB 实现关系存储，自动建立 provenance，Graph 视图
- **发布**：小红书/抖音等平台适配
