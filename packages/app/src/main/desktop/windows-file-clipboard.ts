import { runClipboardCommand } from "./clipboard-command.ts";

const WRITE_FILE_PATHS = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$entry = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$files = [System.Collections.Specialized.StringCollection]::new()
$files.AddRange([string[]]$entry.paths)
$data = [System.Windows.Forms.DataObject]::new()
$data.SetFileDropList($files)
$token = [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($entry.token))
$data.SetData($entry.format, $false, $token)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`;

export async function writeWindowsFilePaths(paths: string[], format: string, token: string): Promise<void> {
	await runClipboardPowerShell(WRITE_FILE_PATHS, { paths, format, token });
}

export async function readWindowsFilePaths(): Promise<string[]> {
	const command = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -AssemblyName System.Windows.Forms",
		"foreach ($path in [System.Windows.Forms.Clipboard]::GetFileDropList()) { [Console]::Out.WriteLine($path) }",
	].join("; ");
	const stdout = await runClipboardPowerShell(command);
	return stdout.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function runClipboardPowerShell(command: string, input?: unknown): Promise<string> {
	return runClipboardCommand("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-Command", command], input);
}
