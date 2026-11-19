**English** | [简体中文](./EDITOR.zh-CN.md)

# Markdown Editing

Edit the `.md` files of a library directly in Loom. A file is always plain Markdown text. Agents, external editors, cloud backup and [file references](./GRAPH-LINKS.md) all read it directly, so the editor introduces no storage format of its own.

## Reference

| Product | Approach |
| --- | --- |
| Typora, Obsidian live preview | Edit the Markdown source directly and use decorations to show headings, bold text and links in their final look, with the raw symbols shown on the line under the cursor. The text is the only data, so nothing is rewritten on a round trip. |
| Notion | The document is a tree of blocks, and Markdown is only for import and export. Every save regenerates the text from the block tree and normalizes the original formatting, which does not suit a case where the file itself is the data. |
| VS Code | Manual save by default, with the tab marking unsaved changes, and optional delayed or on-blur auto save. When the file on disk changes externally, an editor with no unsaved content reloads silently, and one with unsaved content prompts at save time. |

Loom takes the first: live preview over the source text.

## First Version

1. **Edit by default.** A Markdown file has one CodeMirror view. An icon button toggles editing/reading, with a separate source toggle available while editing. Both have tooltips.
2. **Live rendering.** Headings, bold, italic, inline code, links, lists, quotes, task lists and rules show in their final look while editing. When the cursor enters an element, its Markdown symbols are shown.
3. **Reuse existing rendering.** Path resolution for wiki links and `![[embeds]]`, red error marks, click-through and heading anchors reuse the one resolver from [file references](./GRAPH-LINKS.md). Formulas, Mermaid and images show as rendered output and expand to source under the cursor. Tables always stay rendered, with editing inside their cells.
4. **Auto save.** Save about one second after typing stops, and immediately on blur or when switching tabs. No persistent save status bar; only failures and conflicts show a notice with actions.
5. **No change, no write.** The file is written only when its content really changed. The editor never reflows text the user did not touch.
6. **Slash commands.** Type `/` at the start of a line or click Insert in the toolbar. Search in English or Chinese for headings, lists, tasks, code blocks, tables, quotes, rules, formulas, Mermaid diagrams, or links to library files. Pick an option with the keyboard or pointer. The insertion writes Markdown text and can be undone.
7. **Undo and redo.** The undo stack of the editing session is kept, and saving does not clear it.

Notion-style block interaction such as block dragging, block toolbars and columns needs a block-tree data model, which conflicts with the file being the only data, so the first version does not include it.

## Editor

Use [CodeMirror 6](https://codemirror.net/). It edits text directly and provides decorations, folding, input method support and an undo stack. The Markdown syntax tree comes from `@codemirror/lang-markdown`. Live rendering is done with decorations on the syntax tree, and wiki links are recognized as an extension of the syntax, with rules kept in line with `references.ts`.

The editor lives only in the renderer process and does not enter `@loom/core`. Saving is in `MarkdownStore` in the app main process, next to the canvas `CanvasStore`, and the core is not involved.

### Modes and File Sizes

- **Edit:** live rendering over the source, with symbols revealed under the cursor. ⌘/Ctrl+click opens links.
- **Read:** the same view, read-only, with no visible caret. Neither the cursor nor selections reveal source; a plain click opens links. Table cells can be selected and copied but not changed, and grips and add buttons are absent.
- **Source:** available only while editing; turns off live decorations and edits the raw text. Switching to reading clears the source toggle; returning to editing restores live rendering.
- **Switching:** keeps the same editor, text, undo history, caret and scroll position, and flushes pending edits first.

Tiers use the exact disk byte count, including BOM and line endings: ≤ 2 MiB uses live editing; > 2 MiB and ≤ 10 MiB permits source editing only, with reading still available; > 10 MiB opens read-only. Large files show a notice explaining the restriction. Outside changes affect the tier only after the session adopts them, so unsaved edits are not locked out.

### Division with Existing Parsing

The project keeps two Markdown parsers with separate responsibilities:

| Parser | Responsible for |
| --- | --- |
| markdown-it (with texmath, KaTeX and Mermaid) | Rendering HTML for chat, canvas cards and local editor content such as table cells; and reference extraction in the core. |
| Lezer (`@codemirror/lang-markdown`) | Producing a syntax tree with source offsets in the Markdown file view for decorations, source highlighting and heading jumps. The inline tokens of markdown-it carry no offsets, so they cannot do this. |

They are not unified. Lezer does not produce HTML, so unifying would require a rendering layer written from scratch, and the risk outweighs the gain. Swapping only the reference extraction to Lezer would remove the guarantee that the file opened from the preview matches the graph.

Because the same syntax is recognized in two places, drift is contained as follows:

1. **Wiki links have one rule:** `matchWikiLink` and `findWikiLinks` in `references.ts`. The preview's inline rule, the reference extraction and the editor decorations all call it, and none writes its own regular expression. Path resolution is shared as well.
2. **Formulas and Mermaid are not reimplemented:** when the cursor is outside them, the editor calls the existing KaTeX and Mermaid rendering, and the `$` delimiter rules match texmath.
3. **Ordinary syntax is held by sample tests:** the same set of Markdown snippets is checked for the links that the preview, the reference extraction and the editor each recognize, covering code blocks, inline code, escapes and tables.
4. **Lazy loading:** the Markdown file view loads on demand, so CodeMirror does not affect startup size.

## Saving and Conflicts

Follow what the canvas `CanvasStore` does, without a separate mechanism:

1. A read returns the text, revision (a content hash) and exact byte count.
2. A save carries the revision from the read. If the content on disk has changed, it returns a conflict and writes nothing.
3. The write is atomic, and file identity and timestamps are checked again before the commit, so a change between the read and the write by an outside program is detected.
4. A serial queue runs saves for one file in order.
5. The main process refuses to write a file larger than 10 MiB or save text that would exceed that size. Reads are not limited by the editing limit.

After a write, the library watcher triggers a [reference update](./GRAPH-LINKS.md#reference-extraction-and-updates) and the graph follows, so the save path needs no extra handling.

Encoding and line endings: read and write UTF-8, keep the file's existing line-ending style and leading BOM, and use `\n` for new content.

## External Changes

The rules match VS Code:

| Editor state | When the file on disk changes |
| --- | --- |
| No unsaved content | Reload silently and keep the scroll position. |
| Unsaved content | Do not interrupt typing. A conflict is found at save time and the user is told "The file was modified on disk" and chooses Overwrite or Reload. |

Agent writes, external editors and cloud pulls are all treated as external changes. Renaming or moving the asset does not affect editing. If it is deleted, the editing content is kept and the user is prompted to save it elsewhere.

## Relation to Other Features

- **File references:** After a save, the existing reference extraction updates the graph. A missing target shows a red mark in the editor, the same as in the preview.
- **Find:** Editing, reading and source share CodeMirror's search panel, opened with ⌘/Ctrl+F. Reading hides replacement controls. Search covers the full source, regardless of viewport virtualization.
- **Context menu:** Native menus provide undo/redo, cut/copy/paste and select all, alongside table row/column actions. History uses the editor's undo stack; clipboard actions follow the same path as keyboard shortcuts. Reading disables mutations. A table menu acts on selected cell text or a picked cell block; select all selects the cell text or the whole table, respectively.
- **Format selection:** Right-click selected text and choose Format. Bold, italic, strikethrough and inline code act on a selection within one line. Paragraph, headings, lists and quotes convert the full blocks touched by the selection. Convert to Paragraph to remove a block format. Each change writes Markdown and takes one undo.
- **Canvas:** A Markdown card on a canvas is still a read-only excerpt, and the editing view opened by double-click can modify it.
- **Chat preview:** Chat and canvas cards keep the existing read-only rendering, and the editor does not replace it.

## Verification

- Open a file, type nothing, and switch away: the bytes and modification time of the file on disk do not change.
- After editing one paragraph, the rest of the text is byte-for-byte unchanged, including `*` versus `-` list markers, table alignment spaces and trailing blank lines.
- A file with a BOM or `\r\n` keeps its style after saving.
- Change the same file externally during editing: with no unsaved content the new content loads automatically, and with unsaved content the save reports a conflict. After Overwrite the disk holds the editor's content, and after Reload the edits are discarded.
- With Chinese pinyin and Japanese input methods, composition does not trigger a save and does not lose characters.
- Edit the path of `[[Product/Notes]]` and save: the edge in the graph changes accordingly, and when the target is missing the red mark matches the preview.
- Mode switches preserve the same editor, undo history and position. Typing, tasks and table paste/cut/delete do not write in reading mode; copying and finding still work.
- The 2 MiB and 10 MiB boundaries choose the correct tier. Large files open, and the main process also rejects saves beyond 10 MiB.
- Heading jumps find headings outside the viewport, and wiki and ordinary Markdown links share resolution rules.
- Saving, external changes and line endings pass the same tests on Windows and macOS.

## Not Included

- Block dragging, block toolbars, columns and database views.
- Multi-user collaborative editing.
- Comments and revision history.
- A YAML properties panel, in line with the scope of the first version of file references.
- Pasting an image and saving it into the library automatically, which can be evaluated later as a separate feature.
