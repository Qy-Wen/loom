import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultGeneralSettings, parseGeneralSettings, type GeneralSettings } from "../../shared/general-settings.ts";

export class GeneralSettingsStore {
	private readonly filePath: string;
	private settings = defaultGeneralSettings();
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<GeneralSettings> {
		if (this.loaded) return this.settings;
		try {
			this.settings = parseGeneralSettings(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.settings = defaultGeneralSettings();
		}
		this.loaded = true;
		return this.settings;
	}

	async save(settings: GeneralSettings): Promise<GeneralSettings> {
		this.settings = parseGeneralSettings(settings);
		this.loaded = true;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(this.settings, null, "\t")}\n`, "utf8");
		return this.settings;
	}
}
