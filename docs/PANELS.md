**English** | [简体中文](./PANELS.zh-CN.md)

# Panel layout

## Registration

`App.tsx` supplies `PanelRegistration` and `PanelView` entries: stable `id`, title, visibility, content renderer, optional initial placement and first-open policy. Add a panel there; do not add ID branches to the layout hook, drag geometry, tabs, or CSS.

Grade's product default is a first-open join into docked Details/Chat. Existing saved placement wins. A hidden never-opened panel does not consume a visible slot. Visibility changes preserve its position and group; unregistering removes stale IDs.

## Ownership

- `panel-layout.ts`: pure state operations and persistence validation/import.
- `use-panel-layout.ts`: pointer lifecycle, measured landing previews, float bounds, resize, visibility.
- `work-panel.tsx`: generic region/slot rendering and tab bars.
- `shell.css` / `dock.css`: region placement and slot presentation, no panel-specific grid placement.

A slot holds ordered tabs, active tab, placement, and size weight. Regions (`dock`, `beside`, `above`, `bottom`) contain vertically ordered slots; each slot can have an independent tab group. Floating slots keep shell-relative rectangles. Normalized visible weights fill each region even after detaching/hiding another slot.

Top/bottom edge drops split a slot; center drops merge tabs. A tab can detach; dragging a tab bar moves the entire group. Lower central bands retain the existing two-band behavior: an upper-edge drop opens the upper band; a lower-edge drop moves the existing lower band above the newcomer. With multiple slots in a band, edge drops split the selected slot instead. Orders, tabs, and sizes persist.

## Persistence and tests

`loom.layout.panels` stores the versioned slot document. Old per-panel placement, one-group metadata and dock sizes are imported only when this document is absent. Old keys are not written; saved floats/group order survive import. Column widths and central band heights retain their separate settings.

Tests cover existing Chat/Details/Grade behavior plus six arbitrary IDs, independent groups, all ordered panel pairs, hide/show/register/remove, resize, first-open, floats and reopen. Isolated Electron acceptance uses five unrelated panels with the exact same hook/components:

```sh
LOOM_E2E_PANELS=1 LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_PANELS=1 LOOM_E2E_TRACE=1 pnpm exec playwright test
```

Use the shell's environment syntax on Windows. Normal production builds omit the fixture entry. Tests use temporary user data and libraries; Windows on-device layout validation remains separate.
