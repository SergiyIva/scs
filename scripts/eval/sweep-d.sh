#!/usr/bin/env bash
# Эксперимент D: размер чанка и состав заголовка на настоящем корпусе.
# Оба свипа мерились только на 170 чанках (§9 DESIGN), то есть не мерились.
# Реранкер выключен намеренно: свип должен показывать вклад ИНДЕКСА,
# а не работу второй ступени, и без него прогон вчетверо быстрее.
set -u
REPO=${REPO:-unitify}
OUT=/tmp/scs-sweep/results.txt
: > "$OUT"

run () {
  local name="$1" json="$2"
  local cfg=/tmp/scs-sweep/cfg.json
  cat > "$cfg" <<EOF
{
  "repos": [{ "name": "unitify", "path": "/home/sergey/WebstormProjects/unitify", "watch": false }],
  "pg": "postgres://scs:scs@127.0.0.1:5434/scs",
  "search": { "rerank": { "enabled": false } },
  "chunk": $json
}
EOF
  echo "=== $name" | tee -a "$OUT"
  SCS_CONFIG=$cfg npx tsx src/bin/scs.ts index "$REPO" --full 2>/dev/null | grep -E "^чанков" | tee -a "$OUT"
  SCS_CONFIG=$cfg npx tsx src/bin/scs.ts eval "$REPO" --mode semantic 2>/dev/null | sed -n '4p' | tee -a "$OUT"
  SCS_CONFIG=$cfg npx tsx scripts/eval/cluster.mts 2>/dev/null | grep -E "различных|максимум" | tee -a "$OUT"
}

# Раунд 1: размер чанка и состав заголовка.
if [ "${ROUND:-1}" = "1" ]; then
  run "базовая (target 300, все строки)" '{}'
  run "target 200"                       '{ "targetTokens": 200 }'
  run "target 500"                       '{ "targetTokens": 500 }'
  run "без exports"                      '{ "exportsInHeader": false }'
  run "без imports"                      '{ "importsInHeader": false }'
  run "без path-words"                   '{ "pathWordsInHeader": false }'
fi

# Раунд 2: не выгоднее ли чанки ещё крупнее. maxTokens ограничивает, когда узел
# вообще режется, поэтому его двигаем вместе с target. Потолок — контекст модели
# (2048) минус заголовок.
# Раунд 3: эксперимент A на ИСПРАВЛЕННОЙ семантике модульного JSDoc.
# Прежнее сравнение недействительно: оно делалось реализацией, которая брала
# JSDoc первой функции и выдавала его за описание файла.
if [ "${ROUND:-1}" = "3" ]; then
  run "target 500, БЕЗ модульного JSDoc" '{ "moduleDocInHeader": false }'
  run "target 500, С модульным JSDoc"    '{ "moduleDocInHeader": true }'
fi

if [ "${ROUND:-1}" = "2" ]; then
  run "target 700 (= max)"          '{ "targetTokens": 700 }'
  run "target 500, max 1200"        '{ "targetTokens": 500, "maxTokens": 1200 }'
  run "target 800, max 1500"        '{ "targetTokens": 800, "maxTokens": 1500 }'
fi
echo "ГОТОВО" | tee -a "$OUT"
