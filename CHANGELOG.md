# Changelog

[简体中文](./CHANGELOG.zh-CN.md)

## [Unreleased]

## [v0.2.0]

- Embed a canvas board in a Markdown note and preview its cards and connections. Scrolling past the preview stays steady.
- HTML embeds in Markdown fit the width of the note, and titles of embedded notes sit centered under their frames.
- Click below a block at the end of a note and keep typing.
- HTML file cards on a canvas show the page itself.
- The button that collapses the right sidebar stays clickable.
- In macOS full screen, the toolbar sits farther from the top edge.
- Saving a color grade asks before replacing the original file.
- The Agent writes Loom wiki links and content embeds in Markdown.

## [v0.1.10]

- Delete individual cloud library copies from Settings while keeping local files.
- Paste files into the library faster. A file that only disappears for a moment stays until the library confirms it is gone.
- Click below a Markdown table at the end of a note and keep typing.
- On Windows, cloud backup compares file contents when only the creation time changes, so a timestamp change alone is not treated as an edit.
- Pulling a cloud backup refreshes search data for files overwritten while the local library database is kept.
- Chat messages use clearer type and stronger contrast in dark mode.
- The main window opens wider.

## [v0.1.9]

- Click blank space in the sidebar file list to select the library root while keeping the active file tab open.
- Right-click the library root in the sidebar to open its folder menu.
- Copy and paste a selected folder in the sidebar to create a sibling copy in the same directory.
- Paste files copied in Finder or File Explorer, and copy library files out through the system clipboard.
- On Windows, color grade previews render again while the sandbox is on.
- Moving up and down in Markdown no longer skips lines hidden by collapsed formatting.

## [v0.1.8]

- Edit Markdown in live, reading, and source modes. Format text with slash commands and context menus, edit tables in place, and embed notes, images, audio, video, and HTML.
- Edit and preview HTML and common plain-text files from the library.
- Create canvas boards with editable notes, file cards, and groups. Connections stay attached to the chosen sides as cards move. Play audio and video on the board and jump from a card to its source file.
- Open files in preview tabs, pin tabs you want to keep, and navigate back and forward through opened files.
- Follow file references in Graph as Markdown notes and canvas boards change.
- Back up libraries to Tencent Cloud COS and preview changes before pulling them into your local library.
- Switch between Markdown documents faster. Folders, Favorites, and Tags in the sidebar expand and collapse with matching animations and aligned icons and labels.
- Windows uses more compact title-bar controls, and sidebar drop previews follow the rounded window corner on macOS.

## [v0.1.7]

- The built-in MCP service exposes settings tools, so connected clients can work with Loom settings through MCP.
- Help now distinguishes topic navigation from page content, and Help and Settings use consistent scrollbars.
