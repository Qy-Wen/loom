**English** | [简体中文](./SCHEMA.zh-CN.md)

# Metadata tables

> SQLite schema for one asset library. Product context is in [PRODUCT.md](../../PRODUCT.md) sections 3 and 4.
>
> The database is created at `<library>/.loom/metadata.db` when the library opens. Asset files stay on the filesystem. This database is a derived index.

---

## Runtime

`SqliteMetadataStore` opens the file with `better-sqlite3` and sets:

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

`open` runs `CREATE TABLE IF NOT EXISTS`. There is no schema version or migration yet.

On open, try to load the sqlite-vec extension. Child KNN uses `vec_distance_cosine` on `text_chunks.embedding` blobs. There is no `vec0` virtual table: dimension follows the Embedding slot. If the extension is missing, the same cosine runs in JavaScript.

Directories are not rows. The file tree comes from scanning the library. `.loom/` and `.DS_Store` are ignored.

---

## `assets`

One row per file. `asset_id` is the stable identity; `relative_path` is the current location.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY | UUID from `crypto.randomUUID()`. Properties and Level 1 enrichment attach here. |
| `relative_path` | TEXT | NOT NULL UNIQUE | POSIX path relative to the library root, such as `Campaign-A/hero.jpg`. |
| `filename` | TEXT | NOT NULL | Basename, such as `hero.jpg`. |
| `type` | TEXT | NOT NULL | `image`, `video`, `audio`, `text`, or `other`, from the extension. |
| `size` | INTEGER | NOT NULL | File size in bytes. |
| `created_at` | REAL | NOT NULL | `birthtimeMs`, or `ctimeMs` when birth time is 0. Unix epoch milliseconds. |
| `modified_at` | REAL | NOT NULL | `mtimeMs`. Unix epoch milliseconds. |
| `file_system_id` | TEXT | nullable | OS identity `dev:ino`. Null when the filesystem has no usable id, such as FAT. |

Indexes:

- `assets_type_idx` on `type`
- `assets_file_system_id_idx` on `file_system_id` (not unique)

`file_system_id` is how reconciliation recognizes a renamed or moved file on the same volume. It is not Loom's id. After the library root's volume changes, matching uses `relative_path` only, then every `file_system_id` is refreshed.

`relative_path` is unique. An upsert that moves a path onto another row deletes the previous owner of that path first. A full replace parks existing paths at `.loom/__reconcile__/<asset_id>` and updates rows in place, so two files can exchange paths without dropping their property values.

---

## `library_meta`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `key` | TEXT | PRIMARY KEY | Setting name. |
| `value` | TEXT | NOT NULL | Setting value. |

Current key:

| Key | Value |
|---|---|
| `volume_id` | Decimal string of the library root `stat.dev`. Compared on open to detect a copied library. |

---

## `favorites`

Files the user starred. One row per asset. Deleting the asset deletes the row.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, references `assets` ON DELETE CASCADE | Starred file. |
| `created_at` | REAL | NOT NULL | When it was starred. Starring again moves it ahead of the current newest. The list is newest first. |

---

## `tags`

A label shared by files in this library. `Hero` and `hero` are one tag. Deleting the last use deletes the tag.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `tag_id` | TEXT | PRIMARY KEY | UUID. |
| `name` | TEXT | NOT NULL UNIQUE COLLATE NOCASE | Display name, trimmed. At most 64 characters. |
| `created_at` | REAL | NOT NULL | `Date.now()` when the tag was first used. |

## `asset_tags`

One row per file and tag.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | NOT NULL, references `assets` ON DELETE CASCADE | File. |
| `tag_id` | TEXT | NOT NULL, references `tags` ON DELETE CASCADE | Tag. |
| `created_at` | REAL | NOT NULL | When it was added to this file. Chips are oldest first. |

Primary key: `(asset_id, tag_id)`. Index: `asset_tags_tag_idx` on `tag_id`.

---

## `properties`

Library-wide custom field definitions. Values live in `asset_properties`.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `property_id` | TEXT | PRIMARY KEY | UUID. |
| `name` | TEXT | NOT NULL UNIQUE COLLATE NOCASE | Display name. `Status` and `status` conflict. |
| `type` | TEXT | NOT NULL, one of `text`, `number`, `boolean`, `date` | Value type for every asset that uses this field. |
| `created_at` | REAL | NOT NULL | `Date.now()` when the definition was created. Updating the name does not change it. |

A definition's type can change only while no `asset_properties` rows reference it.

---

## `asset_properties`

One value per asset and property. The type comes from `properties`, not from this row.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | NOT NULL, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `property_id` | TEXT | NOT NULL, FK → `properties(property_id)` ON DELETE CASCADE | Definition. |
| `value_text` | TEXT | nullable | Used when `type = text`. |
| `value_number` | REAL | nullable | Used when `type = number`. Finite numbers only. |
| `value_boolean` | INTEGER | nullable, `0` or `1` | Used when `type = boolean`. |
| `value_date` | TEXT | nullable | Used when `type = date`. Calendar date `YYYY-MM-DD`, no time zone. |

Primary key: `(asset_id, property_id)`.

Exactly one of the four value columns is non-null. The store writes the column that matches `properties.type` and nulls the others. SQL does not check that the filled column matches the definition type.

Index: `asset_properties_property_idx` on `property_id`.

Deleting an asset or a property deletes its values.

---

## `asset_metadata`

Level 1 technical metadata cache. One row per asset. Extracted from the file on disk, not from user input.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `version` | INTEGER | NOT NULL | Extractor version. Current value is `1` (`ENRICHMENT_VERSION`). |
| `source_modified_at` | REAL | NOT NULL | `assets.modified_at` at extract time. |
| `status` | TEXT | NOT NULL, one of `ready`, `failed`, `skipped` | Last extract result. |
| `error` | TEXT | nullable | Skip or failure reason. |
| `data` | TEXT | nullable | JSON payload when `status = ready`. |

A row is stale when it is missing, `status` is `failed`, `version` does not match the extractor, or `source_modified_at` differs from `assets.modified_at`. Open and reconcile refresh stale rows. Rename or move of a ready row does not, if `mtime` is unchanged.

`data` is a discriminated union on `kind`:

| `kind` | Fields |
|---|---|
| `image` | `width`, `height`; optional `orientation`, `camera`, `capturedAt` |
| `video` | `duration`; optional `width`, `height`, `videoCodec`, `audioCodec`, `frameRate` |
| `audio` | `duration`; optional `audioCodec` |
| `text` | `text`, `truncated`, `charCount` (txt / md / json / csv, capped at 256 KiB) |

Deleting an asset deletes its enrichment row.

## `assets_fts`

FTS5 virtual table for `search_assets` text queries. One row per asset. Not a source of truth.

| Column | Meaning |
|---|---|
| `asset_id` | Asset UUID. Unindexed; used to map hits back to `assets`. |
| `body` | Filename, relative path, property values, ready Level 1 extracts, and a ready VLM image or video write-up. |

The store rebuilds the table on open when its row count differs from `assets`, and refreshes one row when that asset, its properties, its enrichment, or its VLM write-up change.

Level 2 text RAG chunks live in `text_chunks` and `text_embed_jobs`, not in `asset_metadata`. See [TEXT](../TEXT.md).

Relations are not in this database. They live in Ladybug at `<library>/.loom/graph.db`. See [Graph](#graph-ladybugdb).

---

## `text_embed_jobs`

One row per Markdown asset that has been (or is being) indexed. Missing row means idle.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `status` | TEXT | NOT NULL, one of `embedding`, `ready`, `failed` | Last embed attempt. |
| `model_id` | TEXT | nullable | Embedding slot `model` used for the last run. |
| `source_modified_at` | REAL | NOT NULL | `assets.modified_at` at embed time. Same mtime skip as Level 1. |
| `error` | TEXT | nullable | Failure reason. |
| `child_count` | INTEGER | NOT NULL | Child rows written for this run. |
| `parent_count` | INTEGER | NOT NULL | Parent rows written for this run. |
| `updated_at` | REAL | NOT NULL | `Date.now()` when the row was last written. |

A ready index is stale when `source_modified_at` differs from `assets.modified_at`, or when Settings uses a different embedding model. Rename or move does not rerun if mtime is unchanged. Image, video, and audio rows also go stale if their write-up is newer than the last embed.

---

## `image_vlm`

One row per image that has been (or is being) described by the VLM slot. Missing row means idle. JPEG / PNG / WebP / BMP only.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `status` | TEXT | NOT NULL, one of `describing`, `ready`, `failed` | Last describe attempt. |
| `model_id` | TEXT | nullable | VLM slot `model` used for the last run. |
| `source_modified_at` | REAL | NOT NULL | `assets.modified_at` at describe time. Same mtime skip as Level 1. |
| `error` | TEXT | nullable | Failure reason. |
| `markdown` | TEXT | nullable | Caption / tags Markdown when `status = ready`. |
| `updated_at` | REAL | NOT NULL | `Date.now()` when the row was last written. |

A ready write-up is stale when `source_modified_at` differs from `assets.modified_at`, or when Settings uses a different VLM model. Rename or move does not rerun if mtime is unchanged. The Markdown is folded into `text_chunks` only when the user or Agent runs Embed.

---

## `video_vlm`

One row per video that has been (or is being) described by the VLM slot. Missing row means idle. avi / m4v / mkv / mov / mp4 / webm.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `status` | TEXT | NOT NULL, one of `describing`, `ready`, `failed` | Last describe attempt. |
| `model_id` | TEXT | nullable | VLM slot `model` used for the last run. |
| `source_modified_at` | REAL | NOT NULL | `assets.modified_at` at describe time. Same mtime skip as Level 1. |
| `error` | TEXT | nullable | Failure reason. |
| `markdown` | TEXT | nullable | Caption / tags Markdown when `status = ready`. |
| `updated_at` | REAL | NOT NULL | `Date.now()` when the row was last written. |

A ready write-up is stale when `source_modified_at` differs from `assets.modified_at`, or when Settings uses a different VLM model. Rename or move does not rerun if mtime is unchanged. Native video is tried first (`video_url` data URI, files up to 32 MB). If the endpoint rejects it or the file is larger, FFmpeg extracts 1–3 temp JPEGs (not library assets) and sends them as `image_url`. The Markdown is folded into `text_chunks` only when the user or Agent runs Embed.

---

## `audio_writeup`

One row per standalone audio file that has been (or is being) described by the Audio slot. Missing row means idle. aac / flac / m4a / mp3 / ogg / wav.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `status` | TEXT | NOT NULL, one of `describing`, `ready`, `failed` | Last describe attempt. |
| `model_id` | TEXT | nullable | Audio slot `model` used for the last run. |
| `source_modified_at` | REAL | NOT NULL | `assets.modified_at` at describe time. Same mtime skip as Level 1. |
| `error` | TEXT | nullable | Failure reason. |
| `markdown` | TEXT | nullable | Caption / tags / transcript Markdown when `status = ready`. |
| `updated_at` | REAL | NOT NULL | `Date.now()` when the row was last written. |

A ready write-up is stale when `source_modified_at` differs from `assets.modified_at`, or when Settings uses a different Audio model. Rename or move does not rerun if mtime is unchanged. DashScope-looking URLs send hosted Omni first (`input_audio.data` as `data:;base64,...` + `modalities: ["text"]` + `stream: true`). Other URLs try `audio_url` (data URI, files up to 32 MB), then `input_audio`, then Omni. Files over 32 MB are compacted locally to 16 kHz mono MP3. DashScope’s encoded-audio cap is 10 MB. The Markdown is folded into `text_chunks` only when the user or Agent runs Embed.

---

## `text_chunks`

Parent and child passages for one asset. Only child rows store a vector.

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `chunk_id` | TEXT | PRIMARY KEY | UUID. |
| `asset_id` | TEXT | NOT NULL, FK → `assets(asset_id)` ON DELETE CASCADE | Asset. |
| `parent_id` | TEXT | nullable, FK → `text_chunks(chunk_id)` ON DELETE CASCADE | Null on a parent; child points at its parent. |
| `role` | TEXT | NOT NULL, `parent` or `child` | Row kind. |
| `start_offset` | INTEGER | NOT NULL | Inclusive UTF-16 offset into the Level 1 extract. |
| `end_offset` | INTEGER | NOT NULL | Exclusive UTF-16 offset. |
| `text` | TEXT | NOT NULL | Source span. Parent text is that span, not a concat of overlapping children. |
| `token_count` | INTEGER | NOT NULL | `cl100k_base` token count of `text`. |
| `embedding` | BLOB | nullable | Float32 little-endian vector. Null on parents. |
| `model_id` | TEXT | nullable | Set on children after embed. |

Index: `text_chunks_asset_idx` on `asset_id`. Hybrid Search reads child embeddings here; see [TEXT](./TEXT.md).

Parents are inserted first, then children. Replacing an index deletes children, then parents, then writes the new rows.

---

## DDL

```sql
CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at REAL NOT NULL,
  modified_at REAL NOT NULL,
  file_system_id TEXT
);
CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type);
CREATE INDEX IF NOT EXISTS assets_file_system_id_idx ON assets(file_system_id);

CREATE TABLE IF NOT EXISTS library_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  property_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK(type IN ('text', 'number', 'boolean', 'date')),
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_properties (
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  value_text TEXT,
  value_number REAL,
  value_boolean INTEGER CHECK(value_boolean IN (0, 1)),
  value_date TEXT,
  PRIMARY KEY (asset_id, property_id),
  CHECK (
    (value_text IS NOT NULL) +
    (value_number IS NOT NULL) +
    (value_boolean IS NOT NULL) +
    (value_date IS NOT NULL) = 1
  )
);
CREATE INDEX IF NOT EXISTS asset_properties_property_idx
  ON asset_properties(property_id);

CREATE TABLE IF NOT EXISTS asset_metadata (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_modified_at REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed', 'skipped')),
  error TEXT,
  data TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  asset_id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS text_embed_jobs (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('embedding', 'ready', 'failed')),
  model_id TEXT,
  source_modified_at REAL NOT NULL,
  error TEXT,
  child_count INTEGER NOT NULL DEFAULT 0,
  parent_count INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS text_chunks (
  chunk_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES text_chunks(chunk_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('parent', 'child')),
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  embedding BLOB,
  model_id TEXT,
  CHECK (
    (role = 'parent' AND parent_id IS NULL AND embedding IS NULL)
    OR (role = 'child' AND parent_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS text_chunks_asset_idx ON text_chunks(asset_id);

CREATE TABLE IF NOT EXISTS image_vlm (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
  model_id TEXT,
  source_modified_at REAL NOT NULL,
  error TEXT,
  markdown TEXT,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS video_vlm (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
  model_id TEXT,
  source_modified_at REAL NOT NULL,
  error TEXT,
  markdown TEXT,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_writeup (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
  model_id TEXT,
  source_modified_at REAL NOT NULL,
  error TEXT,
  markdown TEXT,
  updated_at REAL NOT NULL
);
```

---

## Graph (LadybugDB)

`LadybugGraphStore` uses `@ladybugdb/wasm-core` in-process (no server, no native addon). Queries run in memory. `<library>/.loom/graph.db` is a Ladybug `EXPORT DATABASE` folder, loaded with `IMPORT DATABASE` on open. Nodes are asset UUIDs only. Path, properties, and enrichment stay in SQLite.

```
CREATE NODE TABLE IF NOT EXISTS Asset(asset_id STRING, PRIMARY KEY (asset_id));
CREATE REL TABLE IF NOT EXISTS GENERATED_FROM(FROM Asset TO Asset, relation_id STRING);
CREATE REL TABLE IF NOT EXISTS RELATED(FROM Asset TO Asset, relation_id STRING, type STRING);
```

`GENERATED_FROM` is output → source, reserved for FFmpeg convenience tools. Other edge kinds use `RELATED` plus a user-defined `type` (suggested from types already used in the library). Unique `(from, to, type)` is enforced in the store, not by Ladybug. `inspect_asset` returns `generatedFrom` / `generated` plus a `links` list of every touching edge.

Library add/remove MERGEs or `DETACH DELETE`s the `Asset` node. Users create and delete edges from the Graph canvas or Details.
