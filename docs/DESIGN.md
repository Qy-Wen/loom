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
- **Text**: `primary` for headings and body, `body` for secondary prose, `secondary` for labels and icons, `muted` for captions and placeholders, `faint` for disabled and decoration. Use `accent`, `danger`, `warning`, `success` for status text.
- **Border**: `subtle` for dividers inside a panel, `default` for panel and input edges, `strong` for emphasis; `accent` and `danger` for state.
- **Spacing**: `--lm-space-1…9` is 2, 4, 6, 8, 10, 12, 16, 20, 24 px. Use it for `padding`, `margin`, and `gap`. Widths, heights, and offsets stay literal.
- **Radius**: `sm` 5, `md` 8, `lg` 12, `xl` 20, `pill` for boxes. For thin marks the radius must stay below half the short side, so use `hair` 1 (bars up to ~3px, timeline blocks), `line` 2 (indicator lines, small handles), `xs` 3. Never round a thin mark with `sm` or larger: it turns into a pill. Use `50%` for circles.
- **Type**: sizes `2xs` 10 to `4xl` 44; weights `regular`, `medium`, `semibold`, `bold`. Body text is `sm` (12px).
- **Elevation**: `shadow-xs` (resting controls), `sm` (small popovers), `md` (menus, toasts), `lg` (dialogs).
- **Stacking**: use the named `--lm-z-*` tiers. Never write a bare number.
- **Motion**: `dur-instant` 80, `fast` 120, `base` 200, `slow` 280 ms. `reduced-motion` handling stays with the component.

## Rules

1. No raw colors (`#…`, `rgb()`, `oklch()`) outside `tokens.css`. In TypeScript, use `var(--lm-…)` in SVG/styles, or `token("surface-active")` from `design/tokens.ts` for canvas.
2. If no token fits, add one to `tokens.css` first, with a name that says what it is for, not what it looks like (`--lm-surface-hover`, not `--lm-light-gray`).
3. Never use a layer 1 palette token in a component.
4. A one-off value that is a real exception (a vendor color, a data-visualisation hue) gets a named token too, with a comment saying why.

`pnpm --filter @loom/app test` runs `tests/design-tokens.test.ts`, which fails on raw colors, off-scale radii, font sizes, weights, `z-index`, spacing, transition durations, and references to undefined tokens.

## Adding a theme

Dark mode needs one extra block in `tokens.css` that re-maps the layer 2 tokens to other palette values, scoped to `[data-theme="dark"]` or `prefers-color-scheme`. No component changes. Before enabling it, review the places that carry fixed colors on purpose: media overlays (`--lm-media-*`), asset kinds, and the CopilotKit vendor color `--lm-vendor-copy-hover`.

## Known gaps

- Two sets of asset-kind colors exist: `--lm-badge-*` (library list) and `--lm-kind-*` (graph). They should become one set.
- Sizes of layout parts (panel widths, control heights) are not tokenised; they are component constants.
- Text colors are bucketed from about 40 historical grays into five. A few elements shifted by 1–3 levels of lightness when the system was introduced.
