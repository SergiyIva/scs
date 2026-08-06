-- Ф2: лексическая половина гибридного поиска.
--
-- Проблема: для to_tsvector('simple', ...) идентификатор scheduleRedelivery —
-- один токен, и запрос "redelivery" его не находит. Поэтому перед индексацией
-- разворачиваем camelCase / snake_case / kebab-case / пути в отдельные слова
-- и ДОПИСЫВАЕМ их к исходному тексту, сохраняя оригинальные идентификаторы:
--   scheduleRedelivery -> "scheduleRedelivery schedule redelivery"

CREATE OR REPLACE FUNCTION code_tokens(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT t || ' ' || regexp_replace(
           regexp_replace(
             -- HTTPServer -> HTTP Server (аббревиатура + слово)
             regexp_replace(t, '([A-Z]+)([A-Z][a-z])', '\1 \2', 'g'),
             -- scheduleRedelivery -> schedule Redelivery
             '([a-z0-9])([A-Z])', '\1 \2', 'g'),
           -- snake_case, kebab-case, пути и точки
           '[_\-/\.]+', ' ', 'g');
$$;

ALTER TABLE chunks
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', code_tokens(embed_text))) STORED;

CREATE INDEX chunks_fts ON chunks USING gin (tsv);
