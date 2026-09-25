[English](./UI.md) | **简体中文**

# Electron UI 设计（UI Design）

> 本文档是 [PRODUCT.md](./PRODUCT.zh-CN.md) UI 部分的展开，记录 Electron 客户端的界面布局与视图设计。
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
- **中：Workbench** — 占据最大空间，在 Preview / Gallery / Table / Graph 间切换。Preview 直接展示图片、视频、音频、PDF 与常见文本文件；Markdown 默认渲染预览（含公式与库内相对路径图片），可切到 Source。Ctrl/Cmd+F 可在当前 Markdown 或文本中查找。不支持的格式显示基础信息。
- **右：Agent / Details** — 默认显示 Agent；按需切到资产属性与关系，避免次要信息永久占位。Details 支持库级文本、数字、复选框与日期属性。
- 左 / 中 / 右之间的分隔条可拖动调整宽度，双击恢复默认宽度；用户调整结果保存在本地。
- 文件和文件夹支持原生右键菜单：新建文件夹、重命名、复制、粘贴、复制路径、在 Finder 中显示、移到废纸篓。文件树空白处还可新建 Markdown 文件。点击文件夹行会展开或收起。Ctrl/Cmd+C 复制当前选中项，Ctrl/Cmd+V 粘贴到选中文件夹（或选中文件所在目录），F2 重命名，Ctrl/Cmd+Shift+N 新建文件夹。

信息层级保持清晰：左侧回答「有哪些素材」，中间回答「正在看什么」，右侧回答「让 Agent 做什么 / 查看详细信息」。

---

## 3. 多视图（Views）

- **Files View** — 文件树 / 目录浏览
- **Gallery View** — 缩略图网格，适合图片/视频浏览
- **Table / Database View** — Obsidian 风格表格，可直接通过 `Add field` 新增字段，并支持动态属性列、拖动并保存列宽、按真实类型排序、文本过滤与资产选择
- **Graph View** — 全库关系画布。左下角类型图例。可平移、缩放，拖节点挪位置，指针在边缘出 `+` 后拖出建边，点边选中后删除。不做 Cypher 栏。
- **Agent View** — Agent 对话与工作流
