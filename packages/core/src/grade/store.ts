import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeImageGrade, type ImageGradeRecord } from "./types.ts";

export async function readStoredGrade(gradesDir: string, assetId: string): Promise<ImageGradeRecord | undefined> {
	let text: string;
	try {
		text = await readFile(gradePath(gradesDir, assetId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const parsed = JSON.parse(text) as { version?: unknown; grade?: unknown; sourceAssetId?: unknown; lut?: unknown };
		if (parsed.version !== 1) return undefined;
		return {
			version: 1,
			grade: normalizeImageGrade(parsed.grade),
			sourceAssetId: typeof parsed.sourceAssetId === "string" && parsed.sourceAssetId ? parsed.sourceAssetId : undefined,
			lut: typeof parsed.lut === "string" && parsed.lut.trim() ? parsed.lut : undefined,
		};
	} catch {
		return undefined;
	}
}

export async function writeStoredGrade(gradesDir: string, assetId: string, record: ImageGradeRecord): Promise<void> {
	await mkdir(gradesDir, { recursive: true });
	const payload: ImageGradeRecord = {
		version: 1,
		grade: normalizeImageGrade(record.grade),
		sourceAssetId: record.sourceAssetId,
		lut: record.lut,
	};
	await writeFile(gradePath(gradesDir, assetId), `${JSON.stringify(payload)}\n`, "utf8");
}

function gradePath(gradesDir: string, assetId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(assetId)) throw new Error("Invalid asset id");
	return join(gradesDir, `${assetId}.json`);
}
