import { runClipboardCommand } from "./clipboard-command.ts";

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

const WRITE_FILE_PATHS = `
ObjC.import("AppKit");

function run([name]) {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const json = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding);
  const { paths, format, token } = JSON.parse(ObjC.unwrap(json));
  const items = $.NSMutableArray.alloc.init;
  for (const path of paths) {
    const item = $.NSPasteboardItem.alloc.init;
    const url = $.NSURL.fileURLWithPath(path);
    if (!item.setStringForType(url.absoluteString, $.NSPasteboardTypeFileURL)) {
      throw new Error("Could not encode file URL");
    }
    items.addObject(item);
  }
  if (!items.firstObject.setStringForType(token, format)) throw new Error("Could not encode clipboard token");
  const pasteboard = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.writeObjects(items)) throw new Error("Could not write files to the pasteboard");
  // Read back the items and advertised formats before the helper exits.
  const count = Number(pasteboard.pasteboardItems.count);
  const types = pasteboard.types;
  if (count !== paths.length || !types.containsObject($.NSPasteboardTypeFileURL) || !types.containsObject(format)) {
    throw new Error("Could not write the complete file selection to the pasteboard");
  }
  return count;
}
`;

export async function writeMacFilePaths(paths: string[], format: string, token: string, pasteboardName = ""): Promise<void> {
	await runClipboardCommand("/usr/bin/osascript", ["-l", "JavaScript", "-e", WRITE_FILE_PATHS, "--", pasteboardName], { paths, format, token });
}

export async function readMacFilePaths(pasteboardName = ""): Promise<string[]> {
	try {
		const stdout = await runClipboardCommand("/usr/bin/osascript", ["-l", "JavaScript", "-e", READ_FILE_PATHS, "--", pasteboardName]);
		const parsed: unknown = JSON.parse(stdout);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
	} catch {
		return [];
	}
}
