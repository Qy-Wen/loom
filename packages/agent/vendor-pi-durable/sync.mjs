#!/usr/bin/env node
// Portable entry point; sync.sh delegates here. Only sync pristine upstream on vendor-clean.
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = "https://github.com/earendil-works/pi.git";
const vendors = [
  { directory: "packages/durable", destination: here },
  { directory: "packages/codemode", destination: join(here, "../vendor-pi-codemode") },
];
const ref = process.argv[2] ?? "main";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout?.trim();
}

// rsync is not available on native Windows. Mirror the same exclusions there.
async function mirrorWindows(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = (await readdir(source, { withFileTypes: true })).filter(
    (entry) => !entry.name.endsWith(".test.ts") && entry.name !== "testing" && entry.name !== "benchmark",
  );
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of await readdir(destination)) {
    if (!names.has(entry)) await rm(join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const target = join(destination, entry.name);
    // Remove first so file/directory changes are handled too.
    await rm(target, { recursive: true, force: true });
    if (entry.isDirectory()) await mirrorWindows(join(source, entry.name), target);
    else await copyFile(join(source, entry.name), target);
  }
}

try {
  if (process.argv.length > 3 || ref.startsWith("-")) throw new Error("Usage: sync.mjs [ref]");
  const branch = run("git", ["-C", here, "branch", "--show-current"], true);
  if (branch !== "vendor-clean") {
    throw new Error("Vendor sync must run on vendor-clean. Merge the pristine vendor update into your working branch.");
  }
  const temp = await mkdtemp(join(tmpdir(), "loom-pi-durable-"));
  try {
    console.log(`cloning ${repo} @ ${ref} ...`);
    run("git", ["clone", "--depth", "1", "--branch", ref, "--quiet", repo, temp]);
    const commit = run("git", ["-C", temp, "rev-parse", "HEAD"], true);
    for (const vendor of vendors) {
      const source = join(temp, vendor.directory, "src");
      const destination = join(vendor.destination, "src");
      if (process.platform === "win32") {
        await mirrorWindows(source, destination);
      } else {
        await mkdir(destination, { recursive: true });
        run("rsync", [
          "-a", "--delete", "--delete-excluded",
          "--exclude=**/*.test.ts", "--exclude=testing/", "--exclude=benchmark/",
          `${source}/`, `${destination}/`,
        ]);
      }
      await copyFile(join(temp, "LICENSE"), join(vendor.destination, "LICENSE"));
      // No timestamp: syncing the same commit is a content no-op.
      await writeFile(join(vendor.destination, "UPSTREAM"), `repo: ${repo}\ndirectory: ${vendor.directory}\nref: ${ref}\ncommit: ${commit}\n`);
      console.log(`synced pi/${vendor.directory} @ ${ref} (${commit}) -> ${destination}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
