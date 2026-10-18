import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard } from "electron";
import { decodeFileNameW, dropEffectIsMove } from "../../shared/file-clipboard.ts";

const execFileAsync = promisify(execFile);

export interface FileClipboard {
	paths: string[];
	move: boolean;
}

/**
 * File lists sit on the system clipboard in a format Electron does not return.
 * Windows: `FileNameW` is only the first path, so PowerShell reads the full drop list.
 * macOS: file URLs are readable. Finder's cut flag is private, so a paste from Finder copies.
 */
export async function readFileClipboard(): Promise<FileClipboard | null> {
	if (process.platform === "win32") return readWindowsFileClipboard();
	if (process.platform === "darwin") return readMacFileClipboard();
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
		const files = await readMacFileClipboard();
		return files !== null;
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

const MAC_FILE_CLIPBOARD = `
ObjC.import("AppKit");
const pasteboard = $.NSPasteboard.generalPasteboard;
const classes = $.NSMutableArray.alloc.init;
classes.addObject($.NSURL);
const urls = pasteboard.readObjectsForClasses_options(classes, $.NSDictionary.dictionary);
const paths = [];
if (urls && !urls.isNil()) {
  for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(String(ObjC.unwrap(url.path)));
  }
}
console.log(JSON.stringify(paths));
`;

async function readMacFileClipboard(): Promise<FileClipboard | null> {
	try {
		const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", MAC_FILE_CLIPBOARD], {
			timeout: 15_000,
			maxBuffer: 16 * 1024 * 1024,
			encoding: "utf8",
		});
		const line = stdout.split(/\r?\n/).find((item) => item.trim().startsWith("["));
		if (!line) return null;
		const parsed = JSON.parse(line) as unknown;
		if (!Array.isArray(parsed)) return null;
		const paths = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		return paths.length > 0 ? { paths, move: false } : null;
	} catch {
		return null;
	}
}
