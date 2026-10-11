/** Filename placed beside the source: `dir/still.png` → `dir/still_grade.png`. */
export function gradeSiblingRelative(relativePath: string, copy = 1): string {
	const dot = sourceExtension(relativePath);
	return gradeSiblingName(relativePath, copy, gradeExportExtension(dot));
}

/** Graded video is always an MP4 beside the source: `dir/clip.mov` → `dir/clip_grade.mp4`. */
export function gradeVideoSiblingRelative(relativePath: string, copy = 1): string {
	return gradeSiblingName(relativePath, copy, "mp4");
}

function gradeSiblingName(relativePath: string, copy: number, extension: string): string {
	const slash = relativePath.replaceAll("\\", "/");
	const cut = slash.lastIndexOf("/");
	const directory = cut >= 0 ? slash.slice(0, cut) : "";
	const name = slash.slice(cut + 1);
	const dot = name.lastIndexOf(".");
	const rawStem = (dot > 0 ? name.slice(0, dot) : name).trim().replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "output";
	const stem = rawStem.slice(0, 80);
	const filename = `${stem}_grade${copy === 1 ? "" : ` ${copy}`}.${extension}`;
	return directory ? `${directory}/${filename}` : filename;
}

function sourceExtension(relativePath: string): string {
	const slash = relativePath.replaceAll("\\", "/");
	const name = slash.slice(slash.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : "";
}

/** Extension written for a graded still. GIF and unknown types become PNG. */
export function gradeExportExtension(extension: string): string {
	const value = extension.toLowerCase().replace(/^\./, "");
	if (value === "jpeg" || value === "jpg") return "jpg";
	if (value === "png" || value === "webp" || value === "bmp" || value === "tiff") return value;
	if (value === "tif") return "tiff";
	return "png";
}

export function isGradeExportPath(path: string): boolean {
	const value = pathExtension(path);
	return value === "jpg" || value === "jpeg" || value === "png" || value === "webp" || value === "bmp" || value === "tif" || value === "tiff";
}

/** Containers that can hold the H.264 export. WebM cannot. */
export function isGradeVideoExportPath(path: string): boolean {
	const value = pathExtension(path);
	return value === "mp4" || value === "m4v" || value === "mov" || value === "mkv";
}

function pathExtension(path: string): string {
	const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "";
	return name.slice(dot + 1).toLowerCase();
}
