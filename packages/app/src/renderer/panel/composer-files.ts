import { COMPOSER_IMAGE_MAX_BYTES, parseComposerImageInputs, sniffComposerImage, type ComposerImageInput } from "@loom/agent/composer-image";

/** Disk files use paths; pasted screenshots supply bytes because Electron gives them no path. */
export async function composerFileInputs(
	files: readonly File[],
	pathForFile: (file: File) => string,
): Promise<{ paths: string[]; images: ComposerImageInput[] }> {
	const paths: string[] = [];
	const images: ComposerImageInput[] = [];
	for (const file of files) {
		let path = "";
		try { path = pathForFile(file); } catch { /* Clipboard files may have no native path. */ }
		if (path) {
			paths.push(path);
			continue;
		}
		if (file.size > COMPOSER_IMAGE_MAX_BYTES) throw new Error("Each image must be 8 MB or smaller.");
		const bytes = new Uint8Array(await file.arrayBuffer());
		const mimeType = sniffComposerImage(bytes);
		if (!mimeType) throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
		const chunks: string[] = [];
		for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
		images.push({ filename: file.name, mimeType, data: btoa(chunks.join("")) });
	}
	return { paths, images: parseComposerImageInputs(images) };
}
