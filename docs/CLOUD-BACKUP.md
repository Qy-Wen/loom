**English** | [简体中文](./CLOUD-BACKUP.zh-CN.md)

# Cloud backup

Loom connects directly to your cloud account, without a Loom server or account. Tencent COS is currently supported. Each library has one latest copy: updates are manual, local deletions propagate on the next successful update, and restore creates a new local folder. No backup history is kept.

## Set up

1. Create a **private, standard-storage** COS bucket. Note its full name, including APPID, and region, such as `ap-shanghai`. Keep bucket versioning off. If already enabled, suspend it; existing historical versions need separate cleanup. See [versioning configuration](https://cloud.tencent.com/document/product/436/19884).
2. Create a dedicated CAM API key scoped to this bucket. It needs `GetBucket`, `HeadObject`, `GetObject`, `PutObject`, `DeleteObject`, `InitiateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `ListMultipartUploads` and `ListParts`. See the [authorization guide](https://cloud.tencent.com/document/practice/436/31923) and [Node upload guide](https://cloud.tencent.com/document/product/436/64980). ACL modification permission is unnecessary.
3. Open **Settings → Cloud backup**, select Tencent COS and enter the bucket, region and keys. The default prefix `loom/v1` is only a storage path and can be changed. Save and test listing, upload, read and delete access.
4. Open a library and select **Update cloud copy**. On another computer, configure the same bucket and prefix, refresh **Cloud libraries**, restore a completed copy, then open the restored library.

Requests run in Electron Main, so bucket CORS configuration is unnecessary. Credentials are encrypted in app user data and excluded from libraries. Saved values stay in their inputs, masked by default, and can be revealed or edited. Configure credentials and models separately on each computer.

Connection test errors identify the failed COS operation. For `COS DeleteObject: AccessDenied (HTTP 403)`, check that the dedicated user's CAM policy and bucket policy allow `cos:DeleteObject` under the configured prefix, including temporary probes in `connection-test/`. An update with no obsolete remote files can succeed without exercising deletion permission.

## Layout

```text
<backup prefix>/
  libraries/<library ID>/
    Photos/Travel/a.jpg
    Documents/note.md
    .loom/…                 library metadata and the current manifest
  .loom/libraries/<library ID>.json   one current status per library
```

File names, relative paths and empty directories are preserved. IDs isolate libraries and survive root folder renames. Hashes detect content changes and verify restored files; they are not object names. Updates overwrite the current copy instead of creating dated backup directories.

## Update and restore

- Current library backup shows the last successful backup, detected changes and failures. The local cache is scoped by library ID and cloud destination and survives library switches and restarts. Opening a library compares file attributes; matching attributes still require a content preview for verification.
- Preview changes lists added, modified and deleted files and empty folders, plus estimated upload bytes. Metadata and chat changes are collapsed separately. It only reads cloud storage. Preparation briefly pauses library and Agent tasks, then hashes every local file; large libraries take time. Estimates exclude manifests and request overhead.
- File watching covers original files and persistent `.loom` data while excluding caches and local permissions. Changes during or after checking mark the preview as potentially stale; background metadata writes can trigger this too. Updates capture the latest local state; edits during upload remain pending. Offline status does not detect other devices changing the cloud copy; previews refresh the cloud manifest.
- Includes regular files, metadata and graph databases, grade LUTs, chat history, skills, memory and tool results. Excludes preview caches, traces and local command permissions. Links and special files are rejected.
- Preparation stops library/Agent tasks, closes storage, copies persistent metadata and inventories files, then reopens the library. Upload runs in the background. A source file changed before staging causes failure and can be retried.
- Each update reads and hashes files, using remote ETags to upload only new, changed or missing content. Temporary disk usage is approximately persistent metadata plus the largest file. Files over 8 MiB use multipart upload with SDK retries.
- All uploads must succeed before removing remote files and folder markers absent locally. Deletion is bounded to this library's prefix. Cancelled/failed updates remain incomplete and cannot be restored; retry verifies and repairs the copy. There is no previous historical copy to roll back to during an update.
- Restore verifies every size and SHA-256, checks that the remote copy did not change during download, then publishes a new `Loom-restored-…/Library` folder. Existing local files are never replaced. Chat working directories are relocated and unfinished Agent requests are cancelled before scheduling resumes.
- Finish updating a library on one device before using another; concurrent multi-device merging is outside this version. Windows-incompatible names cannot be restored on Windows. Case/Unicode collisions are rejected. File permissions and extended attributes are not preserved.

Configure a COS lifecycle rule for abandoned multipart uploads. Do not expire or archive live copies. Earlier trial `objects/` and `records/` are not migrated or cleared automatically; remove them manually in COS once no longer needed. New updates manage only their `libraries/<library ID>/` subtree and library status file.

## Adding a provider

Provider config/credential types live in `shared/cloud-providers/` and require an explicit `provider`. Extend the config/connection unions, IDs and defaults; register validation and an `ObjectStore` factory in `main/cloud-backup/providers.ts`; add the form and translations in `settings-cloud-providers.tsx`.

The controller receives the factory through dependency injection and the engine has no COS dependency. Adapters own authentication, prefixes, pagination, retries and cancellation. They supply object sizes/content ETags, publish uploads atomically, enforce streaming download limits and delete only the specified object. The storage format contains no provider-specific fields.
