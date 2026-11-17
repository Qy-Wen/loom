import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import COS from "cos-nodejs-sdk-v5";
import { CosObjectStore } from "../src/main/cloud-backup/cos-store.ts";

test("official SDK signs requests, selects multipart for large files, paginates and streams downloads", { timeout: 20_000 }, async () => {
	const objects = new Map<string, Buffer>(), parts = new Map<string, Map<number, Buffer>>();
	const seen: string[] = [];
	let denyDelete = false;
	const server = createServer((request, response) => { void (async () => {
		const url = new URL(request.url!, "http://localhost"), key = decodeURIComponent(url.pathname.slice(1));
		seen.push(`${request.method} ${key}${url.searchParams.has("partNumber") ? " part" : ""}`);
		assert.ok(request.headers.authorization || url.searchParams.has("q-signature"), "every request is authenticated");
		response.setHeader("x-cos-request-id", "local-test");
		const xml = (value: string) => { response.setHeader("content-type", "application/xml"); response.end(value); };
		if (request.method === "GET" && url.searchParams.has("uploads")) { xml("<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>"); return; }
		if (request.method === "POST" && url.searchParams.has("uploads")) {
			const id = randomUUID(); parts.set(id, new Map());
			xml(`<InitiateMultipartUploadResult><Bucket>test-1250000000</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
		}
		if (request.method === "GET" && url.searchParams.has("prefix")) {
			const all = [...objects.keys()].filter((key) => key.startsWith(url.searchParams.get("prefix")!) && key > (url.searchParams.get("marker") ?? "")).sort();
			const page = all.slice(0, 2);
			xml(`<ListBucketResult><Name>test-1250000000</Name><IsTruncated>${all.length > 2}</IsTruncated><NextMarker>${page.at(-1) ?? ""}</NextMarker>${page.map((key) => `<Contents><Key>${key}</Key><Size>${objects.get(key)!.length}</Size></Contents>`).join("")}</ListBucketResult>`); return;
		}
		if (request.method === "HEAD") {
			const bytes = objects.get(key); response.statusCode = bytes ? 200 : 404;
			if (bytes) { response.setHeader("Content-Length", bytes.length); response.setHeader("ETag", createHash("md5").update(bytes).digest("hex")); }
			response.end(); return;
		}
		if (request.method === "DELETE") {
			if (denyDelete) { response.statusCode = 403; xml("<Error><Code>AccessDenied</Code><Message>private signed URL and credentials must not be exposed</Message></Error>"); return; }
			objects.delete(key); response.statusCode = 204; response.end(); return;
		}
		const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		if (request.method === "PUT") {
			if (url.searchParams.has("partNumber")) parts.get(url.searchParams.get("uploadId")!)!.set(Number(url.searchParams.get("partNumber")), bytes);
			else objects.set(key, bytes);
			response.setHeader("ETag", `"${createHash("md5").update(bytes).digest("hex")}"`); response.end(); return;
		}
		if (request.method === "POST" && url.searchParams.has("uploadId")) {
			const uploaded = parts.get(url.searchParams.get("uploadId")!)!;
			objects.set(key, Buffer.concat([...uploaded.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)));
			xml(`<CompleteMultipartUploadResult><Location>test</Location><Bucket>test-1250000000</Bucket><Key>${key}</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>`); return;
		}
		if (request.method === "GET" && objects.has(key)) { response.end(objects.get(key)); return; }
		response.statusCode = 404; xml("<Error><Code>NoSuchKey</Code></Error>");
	})().catch(() => { response.statusCode = 500; response.end(); }); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as import("node:net").AddressInfo).port;
	const directory = await mkdtemp(join(tmpdir(), "loom-cos-sdk-"));
	const credentials = { secretId: "test-id", secretKey: "test-key" };
	const client = new COS({ SecretId: credentials.secretId, SecretKey: credentials.secretKey, Domain: `127.0.0.1:${port}`, Protocol: "http:", Timeout: 2000, ChunkRetryTimes: 0 });
	const store = new CosObjectStore({ provider: "cos", credentials, bucket: "test-1250000000", region: "ap-shanghai", prefix: "loom/v1" }, client);
	const signal = new AbortController().signal;
	try {
		assert.equal(await store.head("missing", signal), undefined);
		const file = join(directory, "upload");
		await writeFile(file, "small object"); await store.upload("records/a", file, signal);
		assert.equal((await store.head("records/a", signal))!.size, Buffer.byteLength("small object"));
		const video = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
		await writeFile(file, video); await store.upload("large-video", file, signal);
		assert.deepEqual(objects.get("loom/v1/large-video"), video);
		assert.equal(seen.filter((value) => value.endsWith(" part")).length, 2);
		assert.ok(!seen.some((value) => value.startsWith("POST loom/v1/records/a")), "small files use simple PUT");
		const parallel = ["parallel/a", "parallel/b", "parallel/c"];
		await Promise.all(parallel.map((key) => store.upload(key, file, signal)));
		for (const key of parallel) assert.deepEqual(objects.get(`loom/v1/${key}`), video, "parallel SDK tasks preserve distinct objects");
		const output = join(directory, "download");
		await store.download("large-video", output, signal, video.length);
		assert.deepEqual(await readFile(output), video);
		await assert.rejects(store.download("large-video", output, signal, 1), /size is invalid/);
		objects.set("loom/v1/records/b", Buffer.from("b")); objects.set("loom/v1/records/c", Buffer.from("c"));
		const listed: string[] = []; for await (const key of store.list("records/", signal)) listed.push(key);
		assert.deepEqual(listed, ["records/a", "records/b", "records/c"]);
		await store.remove("records/b", signal);
		assert.equal(await store.head("records/b", signal), undefined);
		await store.remove("missing", signal);
		denyDelete = true;
		await assert.rejects(store.remove("records/a", signal), { message: "COS DeleteObject: AccessDenied (HTTP 403)" });
		assert.ok(objects.has("loom/v1/records/a"), "failed deletion leaves the object intact");
		const abort = new AbortController();
		await assert.rejects(store.download("large-video", output, abort.signal, video.length, () => abort.abort()));
	} finally {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
