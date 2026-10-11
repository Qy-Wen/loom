/** Explorer sets Preferred DropEffect to 2 for cut. Copy is 1, 5, or absent. */
export function dropEffectIsMove(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer.readUInt32LE(0) === 2;
}

/** `FileNameW` is a single UTF-16 path with trailing nulls. It is only the first file. */
export function decodeFileNameW(buffer: Buffer): string {
	let end = buffer.length;
	while (end >= 2 && buffer.readUInt16LE(end - 2) === 0) end -= 2;
	if (end <= 0) return "";
	return buffer.toString("utf16le", 0, end);
}
