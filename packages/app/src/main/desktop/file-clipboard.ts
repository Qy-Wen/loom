import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard } from "electron";
import { decodeFileNameW, dropEffectIsMove } from "../../shared/file-clipboard.ts";
import { readMacFilePaths } from "./mac-file-clipboard.ts";

const execFileAsync = promisify(execFile);

export interface FileClipboard {
	paths: string[];
	move: boolean;
}

/**
 * Read file lists through each platform's native clipboard API.
 * Windows: `FileNameW` is only the first path, so PowerShell reads the full drop list.
 * macOS: file URLs are readable. Finder's cut flag is private, so a paste from Finder copies.
 */
export async function readFileClipboard(): Promise<FileClipboard | null> {
	if (process.platform === "win32") return readWindowsFileClipboard();
	if (process.platform === "darwin") {
		const paths = await readMacFilePaths();
		return paths.length > 0 ? { paths, move: false } : null;
	}
	return null;
}

export async function clipboardHasFiles(): Promise<boolean> {
	if (process.platform === "win32") {
		try {
			return decodeFileNameW(clipboard.readBuffer("FileNameW")).trim().length > 0;
		} catch {
			return false;
		}
	}
	if (process.platform === "darwin") {
		return (await readMacFilePaths()).length > 0;
	}
	return false;
}

async function readWindowsFileClipboard(): Promise<FileClipboard | null> {
	let move = false;
	try {
		move = dropEffectIsMove(clipboard.readBuffer("Preferred DropEffect"));
	} catch {
		move = false;
	}

	let paths: string[] = [];
	try {
		paths = await readWindowsFileDropList();
	} catch {
		paths = [];
	}
	if (paths.length === 0) {
		try {
			const single = decodeFileNameW(clipboard.readBuffer("FileNameW")).trim();
			if (single) paths = [single];
		} catch {
			paths = [];
		}
	}
	return paths.length > 0 ? { paths, move } : null;
}

async function readWindowsFileDropList(): Promise<string[]> {
	const command = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -AssemblyName System.Windows.Forms",
		"foreach ($path in [System.Windows.Forms.Clipboard]::GetFileDropList()) { [Console]::Out.WriteLine($path) }",
	].join("; ");
	const { stdout } = await execFileAsync("powershell.exe", [
		"-STA",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		command,
	], {
		windowsHide: true,
		timeout: 15_000,
		maxBuffer: 16 * 1024 * 1024,
		encoding: "utf8",
	});
	return stdout.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
