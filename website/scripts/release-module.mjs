import { stat } from "node:fs/promises";
import { readReleaseHighlights } from "../../scripts/release-notes.mjs";

const config = new URL("../release-config.js", import.meta.url);

export async function websiteReleaseModule() {
  const { mtimeMs } = await stat(config);
  const { release } = await import(`${config.href}?mtime=${mtimeMs}`);
  const highlights = await readReleaseHighlights(release.version);
  return `export const release = ${JSON.stringify({ ...release, highlights }, null, 2)};\n`;
}
