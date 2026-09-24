[English](./SCHEMA.md) | **简体中文**

# 元数据表

> 单个资产库的 SQLite 表结构。产品背景见 [PRODUCT.zh-CN.md](../PRODUCT.zh-CN.md) 第 3、4 节。
>
> 打开库时在 `<library>/.loom/metadata.db` 创建。资产文件留在文件系统上，这个库是派生索引。

---

## 运行方式

`SqliteMetadataStore` 用 `better-sqlite3` 打开文件，并设置：

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

`open` 执行 `CREATE TABLE IF NOT EXISTS`。目前没有 schema 版本，也没有迁移。

目录不是表里的行。文件树来自扫描资产库。`.loom/` 和 `.DS_Store` 会被忽略。

---

## `assets`

每个文件一行。`asset_id` 是稳定身份，`relative_path` 是当前路径。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY | `crypto.randomUUID()` 生成的 UUID。属性和 Level 1 富化挂在这上面。 |
| `relative_path` | TEXT | NOT NULL UNIQUE | 相对库根的 POSIX 路径，例如 `Campaign-A/hero.jpg`。 |
| `filename` | TEXT | NOT NULL | 文件名，例如 `hero.jpg`。 |
| `type` | TEXT | NOT NULL | 由扩展名得到：`image`、`video`、`audio`、`text`、`other`。 |
| `size` | INTEGER | NOT NULL | 文件大小，单位字节。 |
| `created_at` | REAL | NOT NULL | `birthtimeMs`；birth time 为 0 时用 `ctimeMs`。Unix 纪元毫秒。 |
| `modified_at` | REAL | NOT NULL | `mtimeMs`。Unix 纪元毫秒。 |
| `file_system_id` | TEXT | 可空 | 操作系统身份，格式 `dev:ino`。文件系统没有可用 id 时为空，例如 FAT。 |

索引：

- `assets_type_idx`，列 `type`
- `assets_file_system_id_idx`，列 `file_system_id`（非唯一）

同一卷上重命名或移动时，对账用 `file_system_id` 认出原文件。它不是 Loom 的 id。库根所在卷变了之后，只按 `relative_path` 对齐，然后刷新全部 `file_system_id`。

`relative_path` 唯一。把路径写到另一行已占用的位置时，先删掉原占用者。全量替换会先把已有路径改到 `.loom/__reconcile__/<asset_id>`，再原地更新，这样两个文件互换路径时不会丢掉属性值。

---

## `library_meta`

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `key` | TEXT | PRIMARY KEY | 设置名。 |
| `value` | TEXT | NOT NULL | 设置值。 |

当前键：

| 键 | 值 |
|---|---|
| `volume_id` | 库根 `stat.dev` 的十进制字符串。打开库时用来判断是不是整库复制到了另一块盘。 |

---

## `properties`

全库共享的自定义字段定义。取值在 `asset_properties`。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `property_id` | TEXT | PRIMARY KEY | UUID。 |
| `name` | TEXT | NOT NULL UNIQUE COLLATE NOCASE | 显示名。`Status` 和 `status` 冲突。 |
| `type` | TEXT | NOT NULL，取值为 `text`、`number`、`boolean`、`date` | 该字段在所有资产上的值类型。 |
| `created_at` | REAL | NOT NULL | 创建定义时的 `Date.now()`。改名不会改这个时间。 |

只有没有任何 `asset_properties` 引用时，才能修改定义的类型。

---

## `asset_properties`

每个资产、每个属性至多一个值。类型来自 `properties`，不记在这一行上。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | NOT NULL，外键 → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `property_id` | TEXT | NOT NULL，外键 → `properties(property_id)` ON DELETE CASCADE | 定义。 |
| `value_text` | TEXT | 可空 | `type = text` 时使用。 |
| `value_number` | REAL | 可空 | `type = number` 时使用。必须是有限数。 |
| `value_boolean` | INTEGER | 可空，`0` 或 `1` | `type = boolean` 时使用。 |
| `value_date` | TEXT | 可空 | `type = date` 时使用。日历日期 `YYYY-MM-DD`，不含时区。 |

主键：`(asset_id, property_id)`。

四个值列里恰好一个非空。写入时按 `properties.type` 填对应列，其余列为 NULL。SQL 不检查被填的列是否和定义类型一致。

索引：`asset_properties_property_idx`，列 `property_id`。

删除资产或属性定义时，对应的值一并删除。

---

## `asset_metadata`

Level 1 技术元数据缓存。每个资产一行。从磁盘文件提取，不是用户输入。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，外键 → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `version` | INTEGER | NOT NULL | 提取器版本。当前为 `1`（`ENRICHMENT_VERSION`）。 |
| `source_modified_at` | REAL | NOT NULL | 提取时的 `assets.modified_at`。 |
| `status` | TEXT | NOT NULL，取值为 `ready`、`failed`、`skipped` | 最近一次提取结果。 |
| `error` | TEXT | 可空 | 跳过或失败原因。 |
| `data` | TEXT | 可空 | `status = ready` 时的 JSON。 |

记录缺失、`version` 与提取器不一致，或 `source_modified_at` 与 `assets.modified_at` 不同，即视为过期。打开和 reconcile 会刷新过期行。Analyze 强制重跑。重命名或移动且 `mtime` 不变时不重算。

`data` 按 `kind` 区分：

| `kind` | 字段 |
|---|---|
| `image` | `width`、`height`；可选 `orientation`、`camera`、`capturedAt` |
| `video` | `duration`；可选 `width`、`height`、`videoCodec`、`audioCodec`、`frameRate` |
| `audio` | `duration`；可选 `audioCodec` |
| `text` | `text`、`truncated`、`charCount`（txt / md / json / csv，上限 256 KiB） |

删除资产时，对应富化行一并删除。

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
```
