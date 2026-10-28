import { JsonFile } from "../storage/file.ts";
import { defaultGeneralSettings, parseGeneralSettings, type GeneralSettings } from "../../shared/general-settings.ts";

export class GeneralSettingsStore {
	private readonly file: JsonFile<GeneralSettings>;
	constructor(filePath: string) { this.file = new JsonFile(filePath, parseGeneralSettings, { recoverCorrupt: true }); }

	async load(): Promise<GeneralSettings> {
		return await this.file.read() ?? defaultGeneralSettings();
	}

	async save(patch: Partial<GeneralSettings>): Promise<GeneralSettings> {
		return this.file.update(async (current) => {
			const next = parseGeneralSettings({ ...current ?? defaultGeneralSettings(), ...patch });
			return { value: next, result: next };
		});
	}
}
