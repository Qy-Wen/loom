import { readFile } from "node:fs/promises";

export function releaseHighlights(markdown, tag) {
  const heading = `## [${tag}]`;
  const sections = markdown.split(/(?=^##[ \t])/m).map((section) => section.split(/\r?\n/));
  const matches = sections.filter(([first]) => first.trimEnd() === heading);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error(`Duplicate changelog section: ${heading}`);

  const items = matches[0].slice(1).map((line) => line.trimEnd()).filter(Boolean);
  if (!items.length || items.some((line) => !line.startsWith("- ") || !line.slice(2).trim())) {
    throw new Error(`${heading} must contain a plain-text bullet list with one item per line.`);
  }
  return items.map((line) => line.slice(2).trim());
}

export async function readReleaseHighlights(tag) {
  if (!tag) return null;
  const paths = ["../CHANGELOG.md", "../CHANGELOG.zh-CN.md"];
  const [en, zh] = await Promise.all(paths.map(async (path) => {
    try { return releaseHighlights(await readFile(new URL(path, import.meta.url), "utf8"), tag); }
    catch (error) { throw new Error(`${path.slice(3)}: ${error.message}`, { cause: error }); }
  }));
  if (!en && !zh) return null;
  if (!en || !zh) throw new Error(`Add a [${tag}] section to ${en ? "CHANGELOG.zh-CN.md" : "CHANGELOG.md"}.`);
  return { en, zh };
}

export function formatReleaseNotes({ en, zh }) {
  const bullets = (items) => items.map((item) => `- ${item}`).join("\n");
  return `## 简体中文\n\n${bullets(zh)}\n\n## English\n\n${bullets(en)}\n`;
}
