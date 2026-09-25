**English** | [简体中文](./SCHEMA.zh-CN.md)

# Metadata tables

> SQLite schema for one asset library. Product context is in [PRODUCT.md](../PRODUCT.md) sections 3 and 4.
>
> The database is created at `<library>/.loom/metadata.db` when the library opens. Asset files stay on the filesystem. This database is a derived index.

---

## Runtime

`SqliteMetadataStore` opens the file with `better-sqlite3` and sets:

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

`open` runs `CREATE TABLE IF NOT EXISTS`. There is no schema version or migration yet.

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

A row is stale when it is missing, `version` does not match the extractor, or `source_modified_at` differs from `assets.modified_at`. Open and reconcile refresh stale rows. Analyze forces a rerun. Rename or move does not, if `mtime` is unchanged.

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
| `body` | Filename, relative path, property values, and ready Level 1 extracts. |

Tokenizer is `unicode61` with diacritics removed. The store rebuilds the table on open when its row count differs from `assets`, and refreshes one row when that asset, its properties, or its enrichment change.

Level 2 text RAG chunks (passage + vector + model id) are not in this schema yet. They will be a separate table keyed by `asset_id`, not a blob inside `asset_metadata`.

Relations are not in this database. They live in Ladybug at `<library>/.loom/graph.db`. See [Graph](#graph-ladybugdb).

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
