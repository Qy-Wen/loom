/** A library-wide label. The same tag can be on many files. */
export interface Tag {
	tagId: string;
	name: string;
}

/** One tag on one file. Chips follow `createdAt`. */
export interface AssetTag {
	assetId: string;
	tagId: string;
	createdAt: number;
}

const MAX_TAG_NAME = 64;

/** Trimmed display name. Empty and overlong names are rejected. */
export function normalizeTagName(name: string): string {
	const trimmed = name.trim().replace(/\s+/g, " ");
	if (!trimmed) throw new Error("Tag name cannot be empty");
	if ([...trimmed].length > MAX_TAG_NAME) throw new Error("Tag name is too long");
	return trimmed;
}

export function tagNameKey(name: string): string {
	return name.toLowerCase();
}
