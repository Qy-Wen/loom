/** A path inside app.asar is rewritten to the unpacked copy. Other paths stay as they are. */
export function unpackAsarPath(filePath: string): string {
	return filePath.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
}
