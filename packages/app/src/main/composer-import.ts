import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseComposerImageInputs } from "@loom/agent";

/** Clipboard images have no file path. Import their validated bytes through the normal Inbox path. */
export async function importComposerFiles<T>(
	filePaths: unknown,
	images: unknown,
	importFiles: (paths: string[]) => Promise<T[]>,
): Promise<T[]> {
	if (!Array.isArray(filePaths) || filePaths.some((path) => typeof path !== "string")) {
		throw new Error("Composer files must be a list of paths");
	}
	const parsed = parseComposerImageInputs(images ?? []);
	if (parsed.length === 0) return importFiles(filePaths);
	const temp = await mkdtemp(join(tmpdir(), "loom-composer-"));
	try {
		const paths = [...filePaths];
		for (const [index, image] of parsed.entries()) {
			// Generated prefix also avoids duplicate names and Windows reserved basenames.
			const name = basename(image.filename.replaceAll("\\", "/")).replace(/[<>:"|?*]/g, "_");
			const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[image.mimeType];
			const stem = basename(name, extname(name)).replace(/[. ]+$/g, "") || "image";
			const path = join(temp, `${index}-${stem}${extension}`);
			await writeFile(path, Buffer.from(image.data, "base64"));
			paths.push(path);
		}
		return await importFiles(paths);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
