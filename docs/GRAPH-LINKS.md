**English** | [简体中文](./GRAPH-LINKS.zh-CN.md)

# File References and the Relationship Graph

Loom extracts internal references from Markdown and canvas files and shows "which file references which file" in the relationship graph. The source file is the source of truth for a reference. The graph and the asset details read the same reference result, and the details of a referenced file can show its backlinks.

## How Obsidian Behaves

| Source | In the graph |
| --- | --- |
| Body links | `[[Product Notes]]` and `[Product Notes](Product%20Notes.md)` both create an edge between files. A display name, `#heading` and `#^block-id` are used for display or positioning; the relationship points to the target file. [Internal links](https://obsidian.md/help/links) |
| Body embeds | `![[Architecture.png]]` is an internal reference. With "Attachments" on, attachment nodes appear in the graph. [Embed files](https://obsidian.md/help/embeds) · [Graph filters](https://obsidian.md/help/plugins/graph) |
| YAML properties | Internal links in text or list properties are also indexed, for example `project: "[[Product Notes]]"`. [Properties](https://obsidian.md/help/properties) · [Internal link index](https://obsidian.md/help/bases/syntax) |
| Canvas file cards | Since Obsidian 1.12, file references on a canvas count toward backlinks and the graph. [1.12 changelog](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/) |

Backlinks show the existing references to a target file. Unlinked mentions can be found in the backlinks panel. Clickable Mermaid internal links are used only inside diagrams. Projecting an arrow between two file cards on a canvas as a vault-wide edge is an optional feature of the Advanced Canvas plugin. [Backlinks](https://obsidian.md/help/plugins/backlinks) · [Mermaid internal links](https://obsidian.md/help/advanced-syntax) · [Advanced Canvas release notes](https://forum.obsidian.md/t/canvas-links-in-cards-and-outgoing-arrows-in-graph-view/49697/103)

## Loom First Version

| File content | Automatic relationship |
| --- | --- |
| `Script.md` contains `[[Product Notes]]` or a regular Markdown internal link | `Script.md` → `Product Notes.md` |
| `Script.md` contains `![[Architecture.png]]` or a regular Markdown internal image link | `Script.md` → `Architecture.png` |
| `Storyboard.canvas` has an asset card that references `Demo.mp4` | `Storyboard.canvas` → `Demo.mp4` |

- **Parse Markdown.** The body supports wiki links, embeds and regular Markdown internal links. The first version does not parse YAML. A Markdown parser identifies body syntax, so link-like text in code and examples is shown as written. Preview and indexing share one path resolver.
- **Locate targets.** Directories in wiki links start from the library root, and regular Markdown relative links resolve from the directory of the source file. When the extension is omitted, the lookup targets Markdown files. Only full paths are recognized, and Loom does not search the whole library by file name: `[[Notes]]` matches only `Notes.md` in the library root, and a file in another directory must be written as `[[Product/Notes]]`, so there is no ambiguity between files with the same name. Clicking a link in the preview opens the asset, and a heading anchor jumps within the file.
- **Parse canvases.** File cards are read by the [canvas asset reference rules](./CANVAS.md#asset-references). `loom.assetId` takes priority, and a standard canvas resolves by the `file` path. Arrows between two cards express relationships inside the canvas.
- **Display and deduplication.** The graph marks whether a relationship comes from Markdown, a canvas or was created manually. When one file references the same asset several times, the references are shown as one. When a pair of files has both an automatic reference and a manual relationship, both are shown as two edges. Removing the last reference removes the edge automatically. A reference that cannot be resolved is marked red in the source file's preview as a reference error. It creates no node or edge in the graph and is resolved again once the target appears.

Loom does not create tag nodes: the graph expresses references between files only, and a tag is not a file.

Loom does not create nodes for notes yet to be created: a reference to a file that does not exist is a reference error and is marked red as described above.

Rewriting Markdown links on rename, and adding canvas arrows to the library-wide graph, can be evaluated later as separate features.

## Indexing and Updates

1. **Build the index when the library opens.** Scan the `.md` and `.canvas` files in the library and record each reference's source and the resolved target asset ID. Body references and repeated cards in the same file share the deduplication rule.
2. **Reuse file change watching.** On save, only the changed source file is read again. When an asset is added, renamed, moved or removed, the affected references are resolved again. Canvas edits, Agent writes, external edits and cloud pulls take effect through the same update mechanism. [Library watcher](../packages/core/src/library/library.ts)
3. **Store automatic references in their own table, in the same database as manual relationships.** Automatic references are written to a separate edge table in the graph database (provisionally named `REFERENCE`), while manual relationships keep using `RELATED`. The two do not affect each other, and existing libraries need no migration. A `REFERENCE` edge records only its start, its end and its source (`markdown` or `canvas`), and its relationship type is always shown as `reference`. An update deletes all `REFERENCE` edges of one source file and writes the new result. The graph store merges both tables when reading, so the graph and backlinks do not distinguish between them, and multi-hop queries traverse both tables. Automatic references are recovered from the source files; if the copy in the graph database is lost, a new scan rebuilds it. They can be removed only by editing the source file. [Existing relation reads](../packages/core/src/local-core.ts)

## Verification

- Use one Markdown file that covers body links, embeds, Chinese paths, heading anchors, code examples and files with the same name in different directories, and check that the file opened from the preview matches what the graph points to.
- Add the same video to a canvas more than once and confirm the graph has a single edge from the canvas to the video. After the last card is removed the automatic edge disappears, and a manual relationship between the same pair of files can still be queried.
- Verify that the graph and backlinks update after a file is changed by an external editor or an Agent, and after the library is reopened following a cloud pull.
