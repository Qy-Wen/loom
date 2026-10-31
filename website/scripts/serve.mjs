import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4173" }, dist: { type: "boolean", default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535.");
const website = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await realpath(values.dist ? join(website, "dist") : website);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };
function insideRoot(path) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let path = resolve(root, `.${pathname.replaceAll("\\", "/")}`);
    if (!insideRoot(path)) { response.writeHead(403).end("Forbidden"); return; }
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    path = await realpath(path);
    if (!insideRoot(path)) { response.writeHead(403).end("Forbidden"); return; }
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const malformed = error instanceof URIError;
    const missing = ["ENOENT", "ENOTDIR"].includes(error.code);
    response.writeHead(malformed ? 400 : missing ? 404 : 500).end(malformed ? "Bad request" : missing ? "Not found" : "Server error");
    if (!malformed && !missing) console.error(error);
  }
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`Loom website: http://127.0.0.1:${port}${values.dist ? " (built files)" : ""}`));
