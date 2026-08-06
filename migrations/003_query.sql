-- Построение tsquery из запроса на естественном языке.
--
-- plainto_tsquery соединяет слова через AND, поэтому запрос вида
-- "где обрабатывается повторная отправка платежа" не найдёт ничего.
-- Нам нужна OR-семантика: совпало любое слово, а важность решает ts_rank.
--
-- Кириллица здесь намеренно отбрасывается фильтром [^a-z0-9_]+: лексическая
-- половина гибрида существует ради точных идентификаторов, а за смысл русского
-- запроса отвечает векторная половина. На русском запросе эта функция вернёт
-- пустой tsquery, и RRF просто отработает по одной ветке.

CREATE OR REPLACE FUNCTION code_query(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT COALESCE(
    to_tsquery('simple',
      (SELECT string_agg(w, ' | ')
         FROM unnest(regexp_split_to_array(lower(code_tokens(q)), '[^a-z0-9_]+')) AS w
        WHERE length(w) > 1)
    ),
    ''::tsquery);
$$;
