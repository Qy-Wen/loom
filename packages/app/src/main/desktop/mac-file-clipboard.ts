import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const READ_FILE_PATHS = `
ObjC.import("AppKit");

function run([name]) {
  const pasteboard = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  const classes = $.NSMutableArray.alloc.init;
  classes.addObject($.NSURL);
  const options = $.NSDictionary.dictionaryWithObjectForKey(
    $.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey,
  );
  const urls = pasteboard.readObjectsForClassesOptions(classes, options);
  const paths = [];
  if (!urls.isNil()) {
    for (let i = 0; i < urls.count; i++) {
      paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
    }
  }
  // osascript writes the return value to stdout and console.log to stderr.
  return JSON.stringify(paths);
}
`;

export async function readMacFilePaths(pasteboardName = ""): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", READ_FILE_PATHS, "--", pasteboardName], {
			timeout: 15_000,
			maxBuffer: 16 * 1024 * 1024,
			encoding: "utf8",
		});
		const parsed: unknown = JSON.parse(stdout);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
	} catch {
		return [];
	}
}
