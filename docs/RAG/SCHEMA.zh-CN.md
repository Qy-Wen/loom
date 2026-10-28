[English](./SCHEMA.md) | **简体中文**

# 元数据表

> 单个资产库的 SQLite 表结构。产品背景见 [PRODUCT.zh-CN.md](../PRODUCT.zh-CN.md) 第 3、4 节。
>
> 打开库时在 `<library>/.loom/metadata-db/metadata.db` 创建。资产文件留在文件系统上。库里大部分内容能从文件重建，但不是全部，见[哪些能重建](#哪些能重建)。

---

## 运行方式

`SqliteMetadataStore` 用 `better-sqlite3` 打开文件，并设置：

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

`open` 执行 `migrate`（`stores/schema.ts`）。`PRAGMA user_version` 是已执行的迁移数，版本 1 就是下面的表结构。要改表就追加一条迁移，不要改已发布的那条。待执行的迁移在同一个事务里，失败时文件保持原样。更新版本的 Loom 写过的库（`user_version` 更高）会被拒绝并提示升级，而不是被打开后写坏。有版本号之前创建的库（`user_version` 为 0）按版本 1 接管，不改动其中的行。

打开时尝试加载 sqlite-vec。子切片近邻用 `vec_distance_cosine` 打 `text_chunks.embedding` blob。不上 `vec0` 虚表：维度跟着 Embedding 槽位。扩展没有就用 JavaScript 算同一套余弦。

目录不是表里的行。文件树来自扫描资产库。`.loom/` 和 `.DS_Store` 会被忽略。

### 哪些能重建

| 能从文件重建 | 用户做的或要花钱调用的，迁移时必须保留 |
|---|---|
| `assets`、`asset_metadata`、`assets_fts`、`chunks_fts` | `favorites`、`tags`、`asset_tags`、`properties`、`asset_properties` |
| `text_chunks` 和 `text_embed_jobs`（文本免费，向量要再调一次 Embedding） | `image_vlm`、`video_vlm`、`audio_writeup`（说明要调一次模型），以及图库里的关系 |

删掉 `.loom/` 会丢右边那一列，所以把它当用户数据，不是缓存。`assets` 能重建，但每个 `asset_id` 都是新的，所以标签和关系接不回去。

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
| `fts_format` | 写入 `assets_fts` 和 `chunks_fts` 时用的分词方式：分词版本加运行环境的 ICU 版本（例如 `1:icu74.2`）。打开库时不一致就重建这两张表。 |

---

## `favorites`

用户标星的文件。每个资产一行。资产删除时这一行跟着删。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，引用 `assets`，ON DELETE CASCADE | 被收藏的文件。 |
| `created_at` | REAL | NOT NULL | 收藏时间。再次收藏会排到当前最新的前面。列表按新到旧排。 |

---

## `tags`

全库共用的标签。`Hero` 和 `hero` 是同一个。最后一个引用去掉后，这个标签也删掉。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `tag_id` | TEXT | PRIMARY KEY | UUID。 |
| `name` | TEXT | NOT NULL UNIQUE COLLATE NOCASE | 显示名，去掉首尾空白。最多 64 个字符。 |
| `created_at` | REAL | NOT NULL | 第一次使用时的 `Date.now()`。 |

## `asset_tags`

一个文件上的一个标签。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | NOT NULL，引用 `assets`，ON DELETE CASCADE | 文件。 |
| `tag_id` | TEXT | NOT NULL，引用 `tags`，ON DELETE CASCADE | 标签。 |
| `created_at` | REAL | NOT NULL | 贴到这个文件上的时间。芯片按旧到新排。 |

主键：`(asset_id, tag_id)`。索引：`asset_tags_tag_idx` 在 `tag_id` 上。

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

记录缺失、`status` 为 `failed`、`version` 与提取器不一致，或 `source_modified_at` 与 `assets.modified_at` 不同，即视为过期。打开和 reconcile 会刷新过期行。就绪记录在重命名或移动且 `mtime` 不变时不重算。

`data` 按 `kind` 区分：

| `kind` | 字段 |
|---|---|
| `image` | `width`、`height`；可选 `orientation`、`camera`、`capturedAt` |
| `video` | `duration`；可选 `width`、`height`、`videoCodec`、`audioCodec`、`frameRate` |
| `audio` | `duration`；可选 `audioCodec` |
| `text` | `text`、`truncated`、`charCount`（txt / md / json / csv，上限 256 KiB） |

删除资产时，对应富化行一并删除。

## `assets_fts`

`search_assets` 文本查询用的 FTS5 虚表。每个资产一行。不是事实来源。`body` 写入前先分词（见 [RAG](./RAG.zh-CN.md#中日韩文字)）：每段中文、日文、韩文用 `Intl.Segmenter` 切成词再用空格连起来，查询才能命中句子中间的词。英文和数字不变。

| 列 | 含义 |
|---|---|
| `asset_id` | 资产 UUID。不建索引，用来把命中映回 `assets`。 |
| `body` | 文件名、相对路径、属性值、已就绪的 Level 1 摘录，以及已就绪的 VLM 图/视频说明。 |

分词器是去掉变音的 `unicode61`。打开时若行数和 `assets` 对不上，或 `library_meta.fts_format` 与当前分词方式不一致，就整表重建；资产、属性、富化或 VLM 说明变更时刷新对应行。

Level 2 文本 RAG 切片在 `text_chunks` 和 `text_embed_jobs`，不在 `asset_metadata`。见 [RAG](./RAG.zh-CN.md#文本索引)。

关系不在这个库里，而在 Ladybug 的 `<library>/.loom/graph-db/graph.db`。见 [图](#graphladybugdb)。

---

## `text_embed_jobs`

每个做过（或正在做）文本索引的 Markdown 资产一行。没有行就是 idle。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，FK → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `status` | TEXT | NOT NULL，`embedding` / `ready` / `failed` | 最近一次 embed。 |
| `model_id` | TEXT | 可空 | 最近一次用的 Embedding 槽位 `model`。 |
| `source_modified_at` | REAL | NOT NULL | embed 时的 `assets.modified_at`。mtime 规则同 Level 1。 |
| `error` | TEXT | 可空 | 失败原因。 |
| `child_count` | INTEGER | NOT NULL | 这次写下的子切片数。 |
| `parent_count` | INTEGER | NOT NULL | 这次写下的父切片数。 |
| `updated_at` | REAL | NOT NULL | 最近写入的 `Date.now()`。 |

`ready` 在 `source_modified_at` 对不上，或设置页换了 embedding 模型时算过期。rename/move 且 mtime 没变不重跑。图片、视频、音频行在说明比上次 embed 新时也算过期。

---

## `image_vlm`

每个做过（或正在做）VLM 说明的图片一行。没有行就是 idle。仅 JPEG / PNG / WebP / BMP。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，FK → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `status` | TEXT | NOT NULL，`describing` / `ready` / `failed` | 最近一次 describe。 |
| `model_id` | TEXT | 可空 | 最近一次用的 VLM 槽位 `model`。 |
| `source_modified_at` | REAL | NOT NULL | describe 时的 `assets.modified_at`。mtime 规则同 Level 1。 |
| `error` | TEXT | 可空 | 失败原因。 |
| `markdown` | TEXT | 可空 | `status = ready` 时的 caption / 标签 Markdown。 |
| `updated_at` | REAL | NOT NULL | 最近写入的 `Date.now()`。 |

`ready` 在 `source_modified_at` 对不上，或设置页换了 VLM 模型时算过期。rename/move 且 mtime 没变不重跑。Markdown 只有用户或 Agent 点 Embed 才会进 `text_chunks`。

---

## `video_vlm`

每个做过（或正在做）VLM 说明的视频一行。没有行就是 idle。avi / m4v / mkv / mov / mp4 / webm。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，FK → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `status` | TEXT | NOT NULL，`describing` / `ready` / `failed` | 最近一次 describe。 |
| `model_id` | TEXT | 可空 | 最近一次用的 VLM 槽位 `model`。 |
| `source_modified_at` | REAL | NOT NULL | describe 时的 `assets.modified_at`。mtime 规则同 Level 1。 |
| `error` | TEXT | 可空 | 失败原因。 |
| `markdown` | TEXT | 可空 | `status = ready` 时的 caption / 标签 Markdown。 |
| `updated_at` | REAL | NOT NULL | 最近写入的 `Date.now()`。 |

`ready` 在 `source_modified_at` 对不上，或设置页换了 VLM 模型时算过期。rename/move 且 mtime 没变不重跑。先试 native video（`video_url` data URI，文件不超过 32 MB）。端点拒收或文件更大时，FFmpeg 抽 1–3 张临时 JPEG（不进素材库）再当 `image_url` 发。Markdown 只有用户或 Agent 点 Embed 才会进 `text_chunks`。

---

## `audio_writeup`

每个做过（或正在做）Audio 槽位说明的独立音频一行。没有行就是 idle。aac / flac / m4a / mp3 / ogg / wav。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `asset_id` | TEXT | PRIMARY KEY，FK → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `status` | TEXT | NOT NULL，`describing` / `ready` / `failed` | 最近一次 describe。 |
| `model_id` | TEXT | 可空 | 最近一次用的 Audio 槽位 `model`。 |
| `source_modified_at` | REAL | NOT NULL | describe 时的 `assets.modified_at`。mtime 规则同 Level 1。 |
| `error` | TEXT | 可空 | 失败原因。 |
| `markdown` | TEXT | 可空 | `status = ready` 时的 caption / 标签 / 转写 Markdown。 |
| `updated_at` | REAL | NOT NULL | 最近写入的 `Date.now()`。 |

`ready` 在 `source_modified_at` 对不上，或设置页换了 Audio 模型时算过期。rename/move 且 mtime 没变不重跑。看起来像 DashScope 的 URL 先发托管 Omni（`input_audio.data` 用 `data:;base64,...` + `modalities: ["text"]` + `stream: true`）。其它 URL 先 `audio_url`（data URI，不超过 32 MB），再 `input_audio`，再 Omni。超过 32 MB 时本地压成 16 kHz 单声道 MP3。DashScope 编码后音频上限 10 MB。Markdown 只有用户或 Agent 点 Embed 才会进 `text_chunks`。

---

## `text_chunks`

一个资产的父子切片。只有子切片存向量。

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `chunk_id` | TEXT | PRIMARY KEY | UUID。 |
| `asset_id` | TEXT | NOT NULL，FK → `assets(asset_id)` ON DELETE CASCADE | 资产。 |
| `parent_id` | TEXT | 可空，FK → `text_chunks(chunk_id)` ON DELETE CASCADE | 父行为空；子行指向父。 |
| `role` | TEXT | NOT NULL，`parent` 或 `child` | 角色。 |
| `start_offset` | INTEGER | NOT NULL | 被切块文本（转换后的 Markdown 或描述）上的闭区间 UTF-16 起点。只存储，不读回。 |
| `end_offset` | INTEGER | NOT NULL | 开区间终点。 |
| `text` | TEXT | NOT NULL | 源文跨度。父切片是这段源文，不是重叠子串拼接。 |
| `token_count` | INTEGER | NOT NULL | `text` 的 `cl100k_base` token 数。 |
| `embedding` | BLOB | 可空 | Float32 小端向量。父行为空。 |
| `model_id` | TEXT | 可空 | 子切片 embed 后写入。 |

索引：`text_chunks_asset_idx`（`asset_id`）。深度检索读这里的子切片向量，见 [RAG](./RAG.zh-CN.md#深度检索)。

先插父再插子。重建时先删子、再删父、再写入。

## `chunks_fts`

深度检索全文路径用的 FTS5 虚表。每个文本非空的**子切片**一行，`rowid` 等于该切片在 `text_chunks` 里的 `rowid`。`body` 是按 `assets_fts` 同样方式分词后的切片正文。不是事实来源。

触发器 `text_chunks_fts_delete` 在子切片被删除时删掉它的行，包括 `ON DELETE CASCADE`（资产被删）和重建索引，所以全文行不会比切片活得久。写入在 `replaceTextChunks` 里，与切片同一事务。打开时若行数和非空子切片数对不上，或 `fts_format` 不一致，就从 `text_chunks` 重建。

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
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS text_chunks_fts_delete AFTER DELETE ON text_chunks
WHEN old.role = 'child'
BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
END;

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

## Graph（LadybugDB）

`LadybugGraphStore` 用 `@ladybugdb/wasm-core` 进程内运行（无独立服务，无原生模块）。查询在内存里做。`<library>/.loom/graph-db/graph.db` 是 Ladybug `EXPORT DATABASE` 目录，打开时 `IMPORT DATABASE`。节点只有资产 UUID。路径、属性和富化仍在 SQLite。

```
CREATE NODE TABLE IF NOT EXISTS Asset(asset_id STRING, PRIMARY KEY (asset_id));
CREATE REL TABLE IF NOT EXISTS RELATED(FROM Asset TO Asset, relation_id STRING, type STRING);
```

每条边都是 `RELATED` 加用户自定的 `type`（提示本库已用过的名字）。`(from, to, type)` 唯一性由 store 保证，不是 Ladybug 约束。`inspect_asset` 返回该资产所有边的 `links`。

库内增删会 MERGE 或 `DETACH DELETE` `Asset` 节点。用户可在 Graph 画布或 Details 里建边、删边。
