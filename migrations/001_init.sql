-- Ф0/Ф1: базовая схема.
-- Размерность вектора зафиксирована на 768 (EmbeddingGemma без Matryoshka-усечения).
-- Конфиг сверяет своё embed.dims с этим значением при старте.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE repos (
  id              serial PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  root_path       text NOT NULL,
  head_commit     text,
  last_indexed_at timestamptz
);

CREATE TABLE files (
  repo_id    int  NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path       text NOT NULL,
  blob_sha   text NOT NULL,
  lang       text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, path)
);

-- Контент-адресуемые чанки: вектор считается один раз на уникальный текст.
-- Переименование файла, checkout другой ветки и скопипащенный код переиспользуют
-- уже посчитанные вектора. model_id входит в хэш, поэтому смена модели создаёт
-- отдельное пространство и не смешивает несравнимые вектора.
CREATE TABLE chunks (
  content_hash bytea PRIMARY KEY,
  embed_text   text        NOT NULL,
  raw_text     text        NOT NULL,
  token_count  int         NOT NULL,
  model_id     text        NOT NULL,
  embedding    vector(768) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunk_locations (
  id           bigserial PRIMARY KEY,
  repo_id      int   NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path         text  NOT NULL,
  content_hash bytea NOT NULL REFERENCES chunks(content_hash),
  start_line   int   NOT NULL,
  end_line     int   NOT NULL,
  symbol       text,
  kind         text  NOT NULL,
  parent_chain text[] NOT NULL DEFAULT '{}',
  lang         text  NOT NULL,
  exported     boolean NOT NULL DEFAULT false
);

CREATE INDEX chunk_loc_repo_path ON chunk_locations (repo_id, path);
CREATE INDEX chunk_loc_hash      ON chunk_locations (content_hash);
CREATE INDEX chunk_loc_symbol    ON chunk_locations USING gin (symbol gin_trgm_ops);

-- HNSW строится после первичной загрузки (см. store/schema.ts::ensureVectorIndex):
-- на пустой таблице он бесполезен, а на 50k векторах строится минуты.
CREATE INDEX chunks_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
