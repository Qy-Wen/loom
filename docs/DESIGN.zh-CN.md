[English](./DESIGN.md) | **简体中文**

# 设计系统

应用里所有视觉取值都在一个文件里：[`packages/app/src/renderer/design/tokens.css`](../packages/app/src/renderer/design/tokens.css)。组件只引用 token，不再重复写颜色、尺寸和时长。有测试强制执行，应用变大后规则也不会松动。

## 分层

| 层 | 前缀 | 组件能直接用吗 |
|---|---|---|
| 1. 色板 | `--lm-palette-*` | 不能。只是原始值，只有第 2 层引用它。 |
| 2. 语义 | `--lm-surface-*`、`--lm-text-*`、`--lm-border-*`、`--lm-accent`、`--lm-danger`…… | 能。组件用的就是这一层。 |
| 3. 尺度 | `--lm-space-*`、`--lm-radius-*`、`--lm-text-size-*`、`--lm-weight-*`、`--lm-shadow-*`、`--lm-z-*`、`--lm-dur-*` | 能。 |

所有 token 都以 `--lm-` 开头，避免和 CopilotKit 的样式表冲突，它定义了 `--accent`、`--background` 这类通用名字。

## 怎么选 token

- **表面**：`app` 是页面底色；`raised` 是卡片、输入框、菜单；`subtle` 和 `sunken` 是安静的面板和凹陷区；`hover`、`active` 是交互状态；`window` 是标题栏；`inverse` 是深色提示和徽标。`accent`、`danger`、`warning`、`success` 各有 `surface-*` 淡底，用于提示条和选中行。
- **文字**：`primary` 用于标题和正文，`body` 用于次级正文，`secondary` 用于标签和图标，`muted` 用于说明和占位。图标、描线、虚线框这类不是文字的元素用 `--lm-graphic`，不要用于文字。状态文字用 `accent`、`danger`、`warning`、`success`。
- **边框**：`subtle` 用于面板内的分隔线，`default` 用于面板和输入框边缘，`strong` 用于强调；状态用 `accent`、`danger`。
- **间距**：`--lm-space-1…9` 依次是 2、4、6、8、10、12、16、20、24 px，用于 `padding`、`margin`、`gap`。宽度、高度、偏移保持字面值。
- **圆角**：盒子用 `sm` 5、`md` 8、`lg` 12、`xl` 20、`pill`。细小的标记，圆角必须小于短边的一半：用 `hair` 1（约 3px 以内的条、时间线块）、`line` 2（指示线、小把手）、`xs` 3。细小标记不要用 `sm` 及以上，否则会变成胶囊。圆形仍用 `50%`。
- **字体**：字号从 `2xs`（10）到 `4xl`（44）；字重 `regular`、`medium`、`semibold`、`bold`。正文是 `sm`（12px）。
- **层次阴影**：`shadow-xs`（静态控件）、`sm`（小浮层）、`md`（菜单、提示）、`lg`（对话框）。
- **素材类型色**：`--lm-asset-image/video/audio/text/other` 是列表徽标、图谱节点、图例、chip 共用的唯一一套，不要再另起一套。
- **层级**：用有名字的 `--lm-z-*`，不要写裸数字。
- **动效**：`dur-instant` 80、`fast` 120、`base` 200、`slow` 280 ms。`reduced-motion` 仍由组件自己处理。

## 规则

1. `tokens.css` 之外不允许出现裸颜色（`#…`、`rgb()`、`oklch()`）。TypeScript 里，SVG 和 style 用 `var(--lm-…)`，canvas 用 `design/tokens.ts` 的 `token("surface-active")`。
2. 没有合适的 token 时，先在 `tokens.css` 里加，名字说明用途而不是外观（`--lm-surface-hover`，不是 `--lm-light-gray`）。
3. 组件里不要使用第 1 层的色板 token。
4. 确实是例外的一次性取值（第三方颜色、数据可视化色相）也要起名并写明原因。

`pnpm --filter @loom/app test` 会运行 `tests/design-tokens.test.ts`。它在出现裸颜色、不在尺度内的圆角、字号、字重、`z-index`、间距、过渡时长，以及引用未定义的 token 时失败。

## 确认框

应用内确认统一使用 `renderer/components/confirm-dialog.tsx` 的 `useConfirmation()`，不用 `window.confirm` 或 Electron 消息框。`confirm({ title, description, confirmLabel, tone })` 返回布尔值；`choose({ title, description, choices, tone })` 返回操作 ID 或 `null`。每个窗口只有一个 `ConfirmationProvider`，问题按顺序显示，同一调用方的重复请求忽略。属于某个素材库或会话的操作，把对应 ID 传给 hook 作为 scope；卸载或 scope 变化会取消尚未回答的问题。

- `normal` 用于普通操作；`warning` 用于权限变更和可恢复的移入废纸篓；`danger` 用于永久删除。
- 按钮写具体动作，说明操作是否可以撤销。
- 默认聚焦取消。Esc 或按下遮罩取消；焦点限制在框内，关闭后恢复。HTML dialog 顶层阻止背景交互，快捷键不穿透到下面的面板。
- 确认 UI 在渲染进程，文件操作及校验仍在主进程。文件/文件夹选择和另存为保留原生窗口。

## 对比度

文字 token（`primary`、`body`、`secondary`、`muted`、状态文字）在它可能落到的每种表面上（从 `app` 到 `active`）都要达到 4.5:1；`--lm-graphic` 和 `--lm-focus-ring` 要达到 3:1；白字压在每个 `--lm-asset-*` 颜色上要达到 4.5:1。`tests/design-tokens.test.ts` 会检查，改色板时破坏这些要求会让构建失败。

## 增加主题

深色模式只需要在 `tokens.css` 里再加一个块，把第 2 层 token 重新映射到别的色板值，作用域用 `[data-theme="dark"]` 或 `prefers-color-scheme`，组件不用改。启用前要检查故意写成固定色的地方：媒体叠层（`--lm-media-*`）、素材类型色，以及 CopilotKit 的 `--lm-vendor-copy-hover`。

## 已知缺口

- 布局尺寸（面板宽度、控件高度）没有 token 化，属于组件常量。
- 文字颜色把历史上约 40 种灰收成 5 档，引入设计系统时少数元素的明度有 1–3 级的变化。
