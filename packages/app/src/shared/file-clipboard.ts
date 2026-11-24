import { win32 } from "node:path";

/** The DROPFILES header is followed by a double-null-terminated list of paths. */
export function decodeWindowsFileDrop(buffer: Buffer): string[] {
	const headerSize = 20;
	if (buffer.length < headerSize || !buffer.readUInt32LE(16)) return [];
	const offset = buffer.readUInt32LE(0);
	if (offset < headerSize || offset > buffer.length - 4 || offset % 2 !== 0) return [];
	const list = buffer.toString("utf16le", offset);
	const end = list.indexOf("\0\0");
	if (end <= 0) return [];
	const paths = list.slice(0, end).split("\0");
	return paths.every((path) => win32.isAbsolute(path)) ? paths : [];
}

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
