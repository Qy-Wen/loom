/** POSIX library-relative path helpers. Do not use node:path on these strings. */

export function assertEntryName(name: string): string {
	const stem = name.trim();
	if (!stem || stem === "." || stem === ".." || /[\\/\0]/.test(stem)) {
		throw new Error("Enter a valid name");
	}
	if (stem === ".loom") throw new Error("That name is reserved");
	return stem;
}

export function joinRelative(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

export function parentRelative(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? "" : relativePath.slice(0, index);
}

export function posixBasename(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? relativePath : relativePath.slice(index + 1);
}

/** Rewrite `oldPrefix` or `oldPrefix/...` to `newPrefix`. */
export function rewriteRelativePrefix(
	relativePath: string,
	oldPrefix: string,
	newPrefix: string,
): string | undefined {
	if (relativePath === oldPrefix) return newPrefix;
	if (relativePath.startsWith(`${oldPrefix}/`)) {
		return `${newPrefix}${relativePath.slice(oldPrefix.length)}`;
	}
	return undefined;
}

/** True when `destFolder` is `sourceFolder` or a descendant of it. */
export function wouldNestInside(sourceFolder: string, destFolder: string): boolean {
	return destFolder === sourceFolder || destFolder.startsWith(`${sourceFolder}/`);
}

export function copyFilename(stem: string, extension: string, copyNumber: number): string {
	return `${stem} copy${copyNumber === 1 ? "" : ` ${copyNumber}`}${extension}`;
}
