/** Filename placed beside the source: `dir/still.png` → `dir/still_grade.png`. */
export function gradeSiblingRelative(relativePath: string, copy = 1): string {
	const slash = relativePath.replaceAll("\\", "/");
	const cut = slash.lastIndexOf("/");
	const directory = cut >= 0 ? slash.slice(0, cut) : "";
	const name = slash.slice(cut + 1);
	const dot = name.lastIndexOf(".");
	const rawStem = (dot > 0 ? name.slice(0, dot) : name).trim().replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "output";
	const stem = rawStem.slice(0, 80);
	const extension = gradeExportExtension(dot > 0 ? name.slice(dot + 1) : "");
	const filename = `${stem}_grade${copy === 1 ? "" : ` ${copy}`}.${extension}`;
	return directory ? `${directory}/${filename}` : filename;
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
	const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false;
	const value = name.slice(dot + 1).toLowerCase();
	return value === "jpg" || value === "jpeg" || value === "png" || value === "webp" || value === "bmp" || value === "tif" || value === "tiff";
}
