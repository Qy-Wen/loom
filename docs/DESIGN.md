**English** | [简体中文](./DESIGN.zh-CN.md)

# Design system

All visual values for the app live in one file, [`packages/app/src/renderer/design/tokens.css`](../packages/app/src/renderer/design/tokens.css). Components reference tokens and never repeat raw colors, sizes, or timings. A test enforces this, so the rule holds as the app grows.

## Layers

| Layer | Prefix | Use it from components? |
|---|---|---|
| 1. Palette | `--lm-palette-*` | No. Raw values; only layer 2 refers to them. |
| 2. Semantic | `--lm-surface-*`, `--lm-text-*`, `--lm-border-*`, `--lm-accent`, `--lm-danger`, … | Yes. This is what components use. |
| 3. Scales | `--lm-space-*`, `--lm-radius-*`, `--lm-text-size-*`, `--lm-weight-*`, `--lm-shadow-*`, `--lm-z-*`, `--lm-dur-*` | Yes. |

Every token starts with `--lm-` so it never collides with the CopilotKit stylesheet, which defines generic names such as `--accent` and `--background`.

## Choosing a token

- **Surface**: `app` is the page; `raised` is cards, inputs, and menus; `subtle` and `sunken` are quiet panels and wells; `hover` and `active` are interaction states; `window` is the title bar; `inverse` is dark tooltips and badges. `accent`, `danger`, `warning`, and `success` have `surface-*` tints for banners and selected rows.
- **Text**: `primary` for headings and body, `body` for secondary prose, `secondary` for labels and icons, `muted` for captions and placeholders. For icons, strokes, and dashed outlines that are not words, use `--lm-graphic`; never use it for text. Use `accent`, `danger`, `warning`, `success` for status text.
- **Border**: `subtle` for dividers inside a panel, `default` for panel and input edges, `strong` for emphasis; `accent` and `danger` for state.
- **Spacing**: `--lm-space-1…9` is 2, 4, 6, 8, 10, 12, 16, 20, 24 px. Use it for `padding`, `margin`, and `gap`. Widths, heights, and offsets stay literal.
- **Radius**: `sm` 5, `md` 8, `lg` 12, `xl` 20, `pill` for boxes. For thin marks the radius must stay below half the short side, so use `hair` 1 (bars up to ~3px, timeline blocks), `line` 2 (indicator lines, small handles), `xs` 3. Never round a thin mark with `sm` or larger: it turns into a pill. Use `50%` for circles.
- **Type**: sizes `2xs` 10 to `4xl` 44; weights `regular`, `medium`, `semibold`, `bold`. Body text is `sm` (12px).
- **Control size**: `--lm-size-xs…3xl` is 16, 20, 24, 28, 32, 36, 40 px on a 4px grid. Use it for the `width`/`height` of buttons, icon slots, and bars (`xs` icon slot, `sm` small icon button, `md` icon button, `lg` toolbar button, `xl` primary control, `3xl` window bar). Odd sizes such as 18, 22, 26, 30 snap to the nearest step. Widths of panels, menus, and dialogs are not on this scale: keep them as `min()`/`clamp()` expressions beside the component, and layout widths such as the library and side panels stay in `layout/` where drag logic owns them.
- **Elevation**: `shadow-xs` (resting controls), `sm` (small popovers), `md` (menus, toasts), `lg` (dialogs).
- **Asset kinds**: `--lm-asset-image/video/audio/text/other` is the single set for list badges, graph nodes, legends, and chips. Never define a second one.
- **Stacking**: use the named `--lm-z-*` tiers. Never write a bare number.
- **Motion**: `dur-instant` 80, `fast` 120, `base` 200, `slow` 280 ms. `reduced-motion` handling stays with the component.

## Rules

1. No raw colors (`#…`, `rgb()`, `oklch()`) outside `tokens.css`. In TypeScript, use `var(--lm-…)` in SVG/styles, or `token("surface-active")` from `design/tokens.ts` for canvas.
2. If no token fits, add one to `tokens.css` first, with a name that says what it is for, not what it looks like (`--lm-surface-hover`, not `--lm-light-gray`).
3. Never use a layer 1 palette token in a component.
4. A one-off value that is a real exception (a vendor color, a data-visualisation hue) gets a named token too, with a comment saying why.

`pnpm --filter @loom/app test` runs `tests/design-tokens.test.ts`, which fails on raw colors, off-scale radii, font sizes, weights, `z-index`, spacing, transition durations, and references to undefined tokens.

## Confirmation dialogs

Use `useConfirmation()` from `renderer/components/confirm-dialog.tsx` for application confirmations, not `window.confirm` or Electron message boxes. `confirm({ title, description, confirmLabel, tone })` resolves to a boolean; `choose({ title, description, choices, tone })` resolves to an action ID or `null`. Each window has one `ConfirmationProvider`; questions are serialized and repeat requests from the same caller are ignored. Pass the library/session ID as the hook's scope when an action belongs to that context. Unmounting or changing scope cancels unanswered questions.

- `normal`: ordinary actions; `warning`: permission changes and recoverable trash operations; `danger`: permanent deletion.
- Use an action-specific label and explain whether the operation can be undone.
- Cancel gets initial focus. Escape or a press on the backdrop cancels; focus stays inside and returns afterward. The HTML dialog top layer blocks background interaction, and keyboard shortcuts do not reach underlying panels.
- Confirmation UI lives in the renderer; filesystem operations and validation stay in main. File/folder pickers and Save As keep their native dialogs.

## Contrast

Text tokens (`primary`, `body`, `secondary`, `muted`, status text) must reach 4.5:1 on every surface they sit on, from `app` down to `active`; `--lm-graphic` and `--lm-focus-ring` must reach 3:1; white text on each `--lm-asset-*` color must reach 4.5:1. `tests/design-tokens.test.ts` checks this, so a palette edit that breaks it fails the build.

## Themes

Light and dark are both defined in `tokens.css`. The dark block at the end re-maps layer 2 (surfaces, text, borders, accent and status colors) and the translucent washes and shadows to the `night-*` and `snow-*` palette. Components never branch on the theme.

- **How it switches.** The Appearance setting (Settings → General) is `system`, `light`, or `dark`. The main process sets `nativeTheme.themeSource`, so `prefers-color-scheme` is correct in every window and the stylesheet needs only one media query. `design/theme.ts` mirrors the result onto `<html data-theme>` and the `dark` class, which tests read and CopilotKit's stylesheet requires.
- **Fixed in both themes.** Asset-kind colors, media overlays (`--lm-on-media`, `--lm-media-*`), and `--lm-media-backdrop` (the letterbox behind video) do not change. Text on them uses `--lm-text-on-asset`, which is white in both.
- **Names that flip.** `--lm-surface-inverse` and `--lm-text-inverse` are the light-on-dark pair for tooltips, primary buttons, and active tab lines. In dark they become light-on-near-black. Use `--lm-text-on-fill` on `--lm-accent-solid` and `--lm-danger` fills, since `--lm-accent` itself is too light for white text in the light theme.
- **CopilotKit.** `design/vendor-copilotkit.css` points its `--background`, `--border`, and related variables at Loom tokens, so the chat follows the theme and matches the surfaces around it.
- **Native chrome.** `shared/theme-colors.ts` holds the few colors the main process paints (window background, Windows title bar). A test compares them with the tokens.
- **Canvas.** Code that paints with `token()` must repaint when the theme flips: subscribe with `onThemeChange` from `design/theme.ts` (see `grade-curve.tsx`).
- **Tests.** `tests/design-tokens.test.ts` runs every contrast check for both themes, so a new dark value that is too faint fails the build. `e2e/appearance.spec.ts` covers the switch end to end.

When adding a token, give it a dark value if the light value is a surface, text, border, shadow, or wash. Check it in both themes before merging.

## Known gaps

- Panel, menu, and dialog widths are not tokenised. They are tied to content or to drag logic in `layout/`, so a shared scale would not help.
- Some exceptions keep literal geometry: the settings switch, the trace table rows, and the shortcut fade. They are listed in `tests/design-tokens.test.ts`.
- The chat widget's own internals (code blocks, tool-call chips) take their colors from CopilotKit's stylesheet. Only its main variables are mapped, so a deep widget state can still show a vendor color in dark.
- Text colors are bucketed from about 40 historical grays into five. A few elements shifted by 1–3 levels of lightness when the system was introduced.
