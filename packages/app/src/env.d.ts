interface ImportMetaEnv {
	readonly DEV: boolean;
	readonly VITE_LOOM_WINDOWS_PREVIEW?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
