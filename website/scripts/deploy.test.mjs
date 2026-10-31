import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ingressConfiguration, shellQuote, validateConfig } from "./deploy.mjs";

const example = JSON.parse(await readFile(new URL("../deploy.config.example.json", import.meta.url), "utf8"));

test("deployment rejects ambiguous targets, injection, broad paths, and traversal", () => {
  assert.equal(validateConfig({ ...example }).domain, "loom.sanzang.site");
  for (const change of [
    { host: "-Fattacker" }, { user: "ubuntu; echo unsafe" }, { port: 0 },
    { domain: "https://loom.sanzang.site" }, { domain: "loom.sanzang.site\nother.site" },
    { remoteDirectory: "/" }, { remoteDirectory: "/home/ubuntu" },
    { remoteDirectory: "/home/ubuntu/loom/../qy-site" }, { remoteDirectory: "/home/ubuntu/site';echo" },
    { ingressConfig: "relative/Caddyfile" }, { ingressNetwork: "network\nOTHER=value" },
    { image: "caddy:2\nSECRET=value" }, { sshBackend: "shell" },
  ]) assert.throws(() => validateConfig({ ...example, ...change }), undefined, JSON.stringify(change));
});

test("ingress setup preserves existing routes and is idempotent", () => {
  const current = "www.sanzang.site {\n  reverse_proxy web:3000\n}\n\nsanzang.site {\n  reverse_proxy web:3000\n}\n";
  const result = ingressConfiguration(current, example.domain);
  assert.ok(result.startsWith(current));
  assert.ok(result.includes("loom.sanzang.site {\n  encode zstd gzip\n  reverse_proxy loom-website:80\n}"));
  assert.equal(ingressConfiguration(result, example.domain), result);
});

test("ingress setup refuses existing unmanaged routes and broken markers", () => {
  for (const current of [
    "loom.sanzang.site { reverse_proxy something-else:80 }",
    "# BEGIN LOOM WEBSITE\nmissing end",
    "# END LOOM WEBSITE\n# BEGIN LOOM WEBSITE",
    "# BEGIN LOOM WEBSITE\n# END LOOM WEBSITE\n# BEGIN LOOM WEBSITE\n# END LOOM WEBSITE",
  ]) assert.throws(() => ingressConfiguration(current, example.domain));
});

test("remote argument quoting keeps shell operators inside a literal argument", () => {
  assert.equal(shellQuote("/home/ubuntu/site"), "'/home/ubuntu/site'");
  assert.equal(shellQuote("a'b;$(touch /tmp/unsafe)"), "'a'\\''b;$(touch /tmp/unsafe)'");
});
