import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { websiteReleaseModule } from "./release-module.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const releaseModule = await websiteReleaseModule();
await mkdir(output, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "translations.js", "assets"]) {
  await cp(join(root, file), join(output, file), { recursive: true });
}
await writeFile(join(output, "release-config.js"), releaseModule);
console.log(`Static website built: ${output}`);
