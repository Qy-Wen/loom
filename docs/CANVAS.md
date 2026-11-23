**English** | [简体中文](./CANVAS.zh-CN.md)

# Canvas Design

A canvas is a workspace in the library that organizes assets around a project or question. Folders manage where assets live, a canvas records what an asset is for in the current task, and the relationship graph records facts shared across the whole library. Edges on a canvas belong to that document.

## Use cases

| Scenario | What the canvas produces |
| --- | --- |
| Asset curation and creative planning | Arrange reference images, video clips, copy, and voice-over into "Opening", "Demo", and "Ending", with shooting or editing notes beside the assets. |
| Cross-file knowledge links | Put technical docs, architecture diagrams, meeting recordings, and code on one canvas, and label how they relate to the current question with "Reference", "Evolution", and "Dependency". |
| Agent-assisted research | The user can ask the Agent to add related assets, organize comparison notes, or link conclusions to sources, then keep editing on the canvas. |

## First version

1. Create or open a `.canvas` file inside the library. Edit it in a workspace tab, reusing the library's existing rename, move, and delete operations.
2. Drag one or more files from the library to create asset cards. Markdown text cards, titled groups, and labeled edges can be created.
3. Pan, zoom, move, resize cards, box-select, move in bulk, and undo/redo. Click selects a card, and pressing and holding a card drags it. Deleting a card also removes the edges connected to it.
4. An asset card shows the file name and a thumbnail when available. A `.md` card shows a scrollable body preview on the canvas. Double-clicking a card opens Loom's existing asset preview, and video and audio are loaded by the preview on demand.
5. Edits autosave. After closing and reopening a canvas, its cards, groups, edges, and layout are restored.

The first acceptance scenario is making a product introduction video. The user creates a canvas in a project folder, adds reference images, a demo video, and voice-over, arranges them as a storyboard, adds copy and order notes, then opens the matching asset from a card.

## File format

Each canvas is a plain UTF-8 JSON file in the library with a `.canvas` extension, and the file name is the canvas title. The base structure follows [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). `nodes` stores cards and groups, and array order is the stacking order from bottom to top. Each edge identifies both cards by ID and requires `fromSide` and `toSide` to keep the endpoints on their chosen sides as cards move. Positions and sizes are integers in canvas coordinates.

```json
{
  "nodes": [
    {
      "id": "opening-note",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 260,
      "height": 140,
      "text": "## Opening\nStart with the problem users run into."
    },
    {
      "id": "opening-video",
      "type": "file",
      "x": 360,
      "y": 0,
      "width": 320,
      "height": 200,
      "file": "videos/product-demo.mp4",
      "loom": { "assetId": "f2d1fecd-1e44-48c9-aab0-1633c980c592" }
    }
  ],
  "edges": [
    {
      "id": "opening-cut",
      "fromNode": "opening-note",
      "fromSide": "right",
      "toNode": "opening-video",
      "toSide": "left",
      "label": "Cut to the demo clip"
    }
  ]
}
```

A standard `group` node uses position, size, and `label` to represent a group. Viewport position, zoom, and selection are local UI state. Parseable extension fields are preserved on read and save. Whether other editors preserve the `loom` extension depends on their implementation, and the standard `file` field still provides a portable path reference.

### Asset references

- **Cards reference assets.** When a library file is dragged in, the canvas stores the card layout, the asset ID, and the relative path. Previews read from the original file or the existing thumbnail. Multiple cards or canvases can share one asset, and deleting a card only affects the canvas document.
- **Card ID and asset ID are independent.** `id` identifies a card within the canvas, and `loom.assetId` identifies a file in the library. When the same asset is placed twice, the two cards have separate IDs and edges.
- **Asset ID resolves first.** After an asset is renamed or moved, cards that resolve through `assetId` keep showing the asset, and `file` is updated on the next save. Paths are relative to the library root and always use `/`, so references still resolve after a canvas is moved within the library.
- **Standard canvases resolve by path.** A card with only `file` is resolved by path in the current library. A card with an `assetId` that fails to resolve keeps its layout, edges, and last recorded path, and is marked "Asset missing". A file at the same path can be offered as a relink candidate for the user to confirm.

## Saving and cloud backup

- The document module validates nodes, edges, and paths. The main process reads and writes canvases in the current library, and keeps the original file and shows an error if a read fails. The editor handles interaction, undo, and preview.
- A layout change is committed when a drag ends. Autosave merges consecutive edits within a short time, writes to each canvas run serially and replace the file atomically through a temporary file. Pending edits are finished before switching libraries and before starting a backup or pull. If the canvas changes on disk outside the app, the user is prompted to resolve the conflict.
- `.canvas` files enter the existing [cloud backup and restore flow](./CLOUD-BACKUP.md) like ordinary files. When two devices both change the same canvas, the existing file-level conflict choice applies. When references are restored across devices, the restored library and its asset index are authoritative.

## Agent canvas operations

The Agent can create and read canvases, and on an existing canvas it can add, edit, or remove asset cards, text cards, groups, and edges, and adjust the layout. Adding an asset follows the canvas's asset reference rules.

The user decides through conversation which canvas to work on and what to accomplish. The Agent shares document validation and saving logic with manual editing, and its operations follow the existing tool permission mechanism.

## Verification

- On macOS and Windows, verify creating, reopening, and moving a canvas and previewing the same asset, covering Chinese file names and nested directories.
- Put the same video on two canvases and confirm only one copy of the video remains on disk. It still previews after a move or rename, and after the original file is deleted the card stays and shows the missing state.
- Verify standard JSON Canvas read and write, that the original file stays intact when a save fails, the prompt for outside changes, and that canvases and asset references are consistent after a backup restore.
