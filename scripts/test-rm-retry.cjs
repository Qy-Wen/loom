// Windows drops directory handles a moment after close. Node retries rm on
// EBUSY, EPERM, and ENOTEMPTY when maxRetries is set.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

function withRetry(options) {
	if (process.platform !== "win32") return options;
	const base = options && typeof options === "object" ? options : {};
	if (Object.prototype.hasOwnProperty.call(base, "maxRetries")) return options;
	return { maxRetries: 15, retryDelay: 100, ...base };
}

const rm = fsp.rm.bind(fsp);
fsp.rm = function rmWithRetry(path, options) {
	return rm(path, withRetry(options));
};

const rmSync = fs.rmSync.bind(fs);
fs.rmSync = function rmSyncWithRetry(path, options) {
	return rmSync(path, withRetry(options));
};
