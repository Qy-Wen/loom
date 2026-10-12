[English](./PANELS.md) | **简体中文**

# 面板布局

## 注册

`App.tsx` 提供 `PanelRegistration` 与 `PanelView`：稳定 `id`、标题、可见性、内容 renderer，可选初始位置与首次打开策略。新增面板在这里注册，不在布局 hook、拖拽几何、tab 或 CSS 中增加 ID 分支。

Grade 的产品默认是首次合入右侧 Details/Chat，已有保存位置优先。隐藏且从未打开的面板不占可见槽位。隐藏/显示保留位置与分组；注销注册项会移除过期 ID。

## 职责

- `panel-layout.ts`：纯状态操作、持久化校验及旧布局导入。
- `use-panel-layout.ts`：指针生命周期、实测落点预览、浮动边界、尺寸调整与可见性。
- `work-panel.tsx`：通用区域/槽位渲染和 tab 栏。
- `shell.css` / `dock.css`：区域放置和槽位样式，不按面板身份放置 Grid。

每个槽位保存有序 tabs、活动 tab、位置和尺寸权重。`dock`、`beside`、`above`、`bottom` 区域包含上下有序槽位，每个槽位可以有独立 tab 组；浮动槽位保存相对 shell 的矩形。按当前可见槽位归一化权重，拖出或隐藏其他槽位后仍填满区域。

拖到上/下边缘拆分槽位，拖到中间合并 tab；单个 tab 可拖出，拖 tab 栏空白处移动整组。中央底部保留现有双区域行为：上边缘打开上层区域，下边缘将现有底部区域移到新面板上方。区域已有多个槽位时，边缘落点拆分选中槽位。顺序、tab 和尺寸持久化。

## 存储与测试

`loom.layout.panels` 保存带版本的槽位文档；只有缺少该文档时导入旧的逐面板位置、单组元数据和停靠尺寸。不再写旧 key，导入保留浮动位置和分组顺序。列宽与中央区域高度继续使用独立设置。

测试覆盖现有 Chat/Details/Grade，以及六个任意 ID、多组独立 tabs、所有有序面板对、隐藏/显示/注册/注销、调整尺寸、首次打开、浮动和重开。隔离 Electron 验收用五个无关面板运行完全相同的 hook/组件：

```sh
LOOM_E2E_PANELS=1 LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_PANELS=1 LOOM_E2E_TRACE=1 pnpm exec playwright test
```

Windows 使用对应 shell 的环境变量语法。普通生产构建不包含 fixture 入口。测试使用临时用户目录和素材库；Windows 实机布局验收另行跟踪。
