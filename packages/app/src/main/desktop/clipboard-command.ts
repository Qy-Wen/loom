import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runClipboardCommand(file: string, args: string[], input?: unknown): Promise<string> {
	const command = execFileAsync(file, args, {
		windowsHide: true,
		timeout: 15_000,
		maxBuffer: 16 * 1024 * 1024,
		encoding: "utf8",
	});
	const stdin = command.child.stdin;
	if (input !== undefined && stdin) {
		// If the helper exits early, execFile reports the failure.
		stdin.on("error", () => undefined);
		stdin.end(JSON.stringify(input));
	}
	return (await command).stdout;
}
