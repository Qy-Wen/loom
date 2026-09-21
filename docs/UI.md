# Electron UI 设计（UI Design）

> 本文档是 [PRODUCT.md](./PRODUCT.md) UI 部分的展开，记录 Electron 客户端的界面布局与视图设计。
>
> PRODUCT.md 只保留大框架，界面细节在此维护。

---

## 1. 整体气质

**Obsidian + Finder + Lightroom + Cursor**。

- Obsidian：本地文件 + 自定义属性 + 关系
- Finder：文件树 / 目录浏览
- Lightroom：媒体预览 / Gallery / 评分筛选
- Cursor：常驻 Agent 对话

---

## 2. 主界面布局

```
┌───────────────────────────────────────────────────────────┐
│ Loom                  Library / Gallery / Table / Graph   │
├──────────────┬──────────────────────────┬─────────────────┤
│ Asset Library│                          │ Agent / Details │
│ Open Folder  │      Preview / Gallery   │                 │
│              │                          │ CopilotChat     │
│ File Tree    │                          │ 或属性 / 关系   │
│              │                          │                 │
└──────────────┴──────────────────────────┴─────────────────┘
```

- **左：Asset Library** — 素材库入口与真实文件层级，保持窄而稳定。
- **中：Workbench** — 占据最大空间，在 Preview / Gallery / Table / Graph 间切换。Preview 直接展示图片、视频、音频、PDF 与常见文本文件；不支持的格式显示基础信息。
- **右：Agent / Details** — 默认显示 Agent；按需切到资产属性与关系，避免次要信息永久占位。
- 左 / 中 / 右之间的分隔条可拖动调整宽度，双击恢复默认宽度；用户调整结果保存在本地。

信息层级保持清晰：左侧回答「有哪些素材」，中间回答「正在看什么」，右侧回答「让 Agent 做什么 / 查看详细信息」。

---

## 3. 多视图（Views）

- **Files View** — 文件树 / 目录浏览
- **Gallery View** — 缩略图网格，适合图片/视频浏览
- **Table / Database View** — Obsidian 风格的属性表格，可排序、过滤
- **Graph View** — 资产关系图可视化
- **Agent View** — Agent 对话与工作流
