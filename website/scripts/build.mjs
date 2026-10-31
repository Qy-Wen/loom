import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
await mkdir(output, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "translations.js", "release-config.js", "assets"]) {
  await cp(join(root, file), join(output, file), { recursive: true });
}
console.log(`Static website built: ${output}`);
