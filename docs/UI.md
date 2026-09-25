**English** | [简体中文](./UI.zh-CN.md)

# Electron UI Design

> This document expands the UI section of [PRODUCT.md](./PRODUCT.md) and records the Electron client's layout and views.
>
> PRODUCT.md keeps only the high-level framework; UI details live here.

---

## 1. Visual direction

**Obsidian + Finder + Lightroom + Cursor**.

- Obsidian: local files, custom properties, and relationships
- Finder: file tree and directory browsing
- Lightroom: media preview, Gallery, ratings, and filters
- Cursor: a persistent Agent conversation

---

## 2. Main layout

```
┌───────────────────────────────────────────────────────────┐
│ Loom                  Library / Gallery / Table / Graph   │
├──────────────┬──────────────────────────┬─────────────────┤
│ Asset Library│                          │ Agent / Details │
│ Open Folder  │      Preview / Gallery   │                 │
│              │                          │ CopilotChat     │
│ File Tree    │                          │ or properties / │
│              │                          │ relationships   │
└──────────────┴──────────────────────────┴─────────────────┘
```

- **Left — Asset Library:** entry point for the library and its real filesystem hierarchy; narrow and stable.
- **Center — Workbench:** the largest area, switching among Preview, Gallery, Table, and Graph. Preview directly displays images, video, audio, PDFs, and common text files; unsupported formats show basic information.
- **Right — Agent / Details:** Agent by default, with asset properties and relationships available on demand so secondary information does not permanently consume space. Details supports library-wide text, number, checkbox, and date properties.
- Dividers between the three columns are draggable. Double-click restores the default width, and preferences are stored locally.
- Files have a native context menu for rename, duplicate, copy path, reveal in Finder, and move to Trash.

The information hierarchy stays clear: the left answers “what assets do I have,” the center answers “what am I looking at,” and the right answers “what should the Agent do / what are the details.”

---

## 3. Views

- **Files View:** filesystem tree and directory browsing
- **Gallery View:** thumbnail grid for images and video
- **Table / Database View:** Obsidian-style table with an `Add field` action, dynamic property columns, draggable persisted column widths, typed sorting, text filtering, and asset selection
- **Graph View:** canvas of every library asset and its edges. Type legend at the lower left. Pan, zoom, drag a node to move it, hover the rim for `+` to drag out an edge, click an edge to select and delete it. No Cypher bar.
- **Agent View:** Agent conversation and workflows
