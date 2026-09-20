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
┌─────────────┬───────────────────────┬──────────────┐
│ File Tree   │                       │ Properties   │
│             │      Preview          │              │
│ Campaign    │                       │ type: video  │
│ ├ image     │                       │ rating: 5    │
│ ├ video     │                       │ project: xx  │
│ └ text      │                       │              │
│             │                       │ Relations    │
│             │                       │ A → B        │
├─────────────┴───────────────────────┴──────────────┤
│ Agent                                                │
│ > 找到去年类似这个风格的图片并帮我做成视频           │
└─────────────────────────────────────────────────────┘
```

- **左：File Tree** — 反映真实文件系统层级（用户自组织）
- **中：Preview** — 图片 / 视频 / 文本素材实时预览
- **右：Properties + Relations** — 自定义属性字段与关系图关联
- **底：Agent** — 常驻对话入口

---

## 3. 多视图（Views）

- **Files View** — 文件树 / 目录浏览
- **Gallery View** — 缩略图网格，适合图片/视频浏览
- **Table / Database View** — Obsidian 风格的属性表格，可排序、过滤
- **Graph View** — 资产关系图可视化
- **Agent View** — Agent 对话与工作流
