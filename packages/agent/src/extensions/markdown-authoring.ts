import { section } from "../durable-adapter.ts";

export const markdownAuthoringSection = section("markdown_authoring", () =>
	"In Loom Markdown files, use wiki links such as `[[notes/Brief]]` to link to library files and embeds such as `![[notes/Brief]]` or `![[images/cover.png]]` to show their contents in the document. " +
	"Use the target's path from the library root with `/` separators. You may omit `.md` for Markdown notes. Preserve existing wiki links and embeds unless the user asks to change them.",
);
