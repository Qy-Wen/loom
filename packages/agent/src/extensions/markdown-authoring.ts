import { section } from "../durable-adapter.ts";

export const markdownAuthoringSection = section("markdown_authoring", () =>
	"In Loom Markdown, use `[[path/to/file.ext]]` to link to a library file and `![[path/to/file.ext]]` to embed it. Use paths from the library root with `/` separators. You may omit `.md` for notes and embed a heading section with `![[notes/Brief#Overview]]`. Preserve existing links and embeds unless the user asks to change them. " +
	"Loom previews images, Markdown notes, `.canvas` files, and standalone HTML pages in the document, and plays embedded audio and video. Put block embeds on their own line outside tables for a full preview. Other embedded files appear as clickable file cards. " +
	"Prefer embedding the original file in its native format. Convert it only when requested or required by the destination. For example, save an HTML diagram as a library file and add `![[diagrams/architecture.html]]`. Raw HTML in the Markdown source is treated as text. " +
	"Loom also renders fenced `mermaid` diagrams and math written with `$...$` or `$$...$$` directly in Markdown.",
);
