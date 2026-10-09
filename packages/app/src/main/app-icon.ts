import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, nativeImage, type NativeImage } from "electron";

function iconPath(): string | undefined {
	const candidates = [
		join(app.getAppPath(), "resources", "icon.png"),
		join(import.meta.dirname, "../../resources/icon.png"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

export function loadAppIcon(): NativeImage | undefined {
	const path = iconPath();
	if (!path) return undefined;
	const image = nativeImage.createFromPath(path);
	return image.isEmpty() ? undefined : image;
}

// dock.setIcon draws the bitmap into the whole tile. System icons are
// squircles whose box is 80/98 of that tile, measured against the others.
const DOCK_SQUIRCLE = 80 / 98;
const SQUIRCLE_N = 5;

function macDockIcon(source: NativeImage): NativeImage {
	const size = 1024;
	const box = 2 * Math.round((size * DOCK_SQUIRCLE) / 2);
	const origin = (size - box) / 2;
	const scaled = source.resize({ width: box, height: box, quality: "best" });
	const { width, height } = scaled.getSize();
	const src = scaled.toBitmap();
	const out = Buffer.alloc(size * size * 4);
	const half = box / 2;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let cover = 0;
			for (const ox of [0.25, 0.75]) {
				for (const oy of [0.25, 0.75]) {
					const dx = Math.abs(x + ox - half) / half;
					const dy = Math.abs(y + oy - half) / half;
					if (dx ** SQUIRCLE_N + dy ** SQUIRCLE_N <= 1) cover++;
				}
			}
			if (cover === 0) continue;
			const c = cover / 4;
			const si = (y * width + x) * 4;
			const di = ((y + origin) * size + (x + origin)) * 4;
			out[di] = Math.round(src[si]! * c);
			out[di + 1] = Math.round(src[si + 1]! * c);
			out[di + 2] = Math.round(src[si + 2]! * c);
			out[di + 3] = Math.round(src[si + 3]! * c);
		}
	}
	return nativeImage.createFromBitmap(out, { width: size, height: size });
}

/** Dock icon on macOS, taskbar identity on Windows. The window icon is separate. */
export function applyAppIcon(): void {
	if (process.platform === "win32") app.setAppUserModelId("com.loom.app");
	const icon = loadAppIcon();
	if (icon && process.platform === "darwin") app.dock?.setIcon(macDockIcon(icon));
}
