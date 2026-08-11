import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { search } from '../store/search.js'
import { db } from '../store/pool.js'
import { loadConfig } from '../config.js'
import { Embedder } from '../embed/client.js'
import { Reranker } from '../rerank/client.js'
import type { GoldenEntry } from './run.js'

/**
 * Приёмочный прогон по отложенному набору.
 *
 * Отдельная команда, а не флаг к `scs eval`, по трём причинам, каждая из которых
 * была пробелом в прошлой версии процедуры:
 *
 * 1. **Пороги проверяются кодом, а не глазами.** «Число получено на отложенном
 *    наборе» само по себе ничего не значит: при таком правиле выпуск разрешает
 *    любое число. Пороги объявлены заранее (docs/RECALL85.md §4.2) и зашиты сюда.
 * 2. **Нужен ненулевой код возврата.** Приёмка, которая при провале печатает
 *    текст и завершается успехом, в конвейере бесполезна.
 * 3. **Нужен отпечаток.** Через полгода «мы померили 47%» без коммита, конфига
 *    и модели — это не результат, а воспоминание.
 *
 * Глубина 50, а не 10: доля «ответа нет и в топ-50» — второй объявленный порог,
 * и без неё провал невозможно разложить на доступность и ранжирование.
 *
 * Конфигурация — ПРОДОВАЯ, без исследовательских послаблений. В частности,
 * диверсификация не отключается: `scs eval` зовёт поиск с maxPerFile = 99,
 * чтобы мерить ранжирование в чистом виде, но пользователь получает выдачу
 * с ограничением в два чанка на файл. Приёмка обязана мерить то, что получает
 * пользователь, иначе она аттестует не тот продукт.
 */

export interface AcceptThresholds {
  recallAt5: number
  wilsonLowerAt5: number
  recallAt10: number
  maxMissingAt50: number
}

/**
 * Пороги заморожены до открытия отложенного набора. Менять их ПОСЛЕ прогона —
 * подлог; менять ДО, по настроечным данным, — ровно то, для чего настроечный
 * набор существует.
 *
 * История одного порога записана намеренно, чтобы через полгода никто не решил,
 * будто цифру подогнали под результат. `maxMissingAt50` изначально стоял на 30%,
 * и это была ошибка постановки: величина уже была измерена (`scs depth` давал
 * доступность @50 = 67.2%, то есть 32.8% отсутствующих), но с порогом не сверена.
 * Первый же приёмочный прогон на НАСТРОЕЧНОМ наборе дал 31.0% и провалился —
 * то есть гейт был недостижим по построению, а не по качеству системы.
 *
 * Новое значение выведено из данных, а не назначено:
 *   - продовый прогон на настроечном наборе: 18 промахов из 58 = 31.0%;
 *   - верхняя граница 95% Уилсона для 18/58 = 43.8%;
 *   - 45% — округление этой границы вверх, то есть предел статистически
 *     правдоподобного ухудшения при переходе на другой набор.
 * На сотне запросов это означает не более 45 промахов, то есть recall@50 ≥ 55%.
 *
 * Отложенный набор к моменту исправления открыт НЕ БЫЛ: прежние 30% к нему
 * не применялись ни разу.
 *
 * Критерий не дублирует остальные: recall@5 и recall@10 проверяют верх выдачи,
 * а missing@50 отдельно защищает полноту пула — случай, когда ответа нет вовсе
 * и никакое ранжирование его не достанет.
 */
export const FROZEN_THRESHOLDS: AcceptThresholds = {
  recallAt5: 0.4,
  wilsonLowerAt5: 0.33,
  recallAt10: 0.48,
  maxMissingAt50: 0.45,
}

export interface AcceptResult {
  queries: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  recallAt50: number
  wilsonLowerAt5: number
  missingAt50: number
  /** Сопоставим с публикуемым числом: `scs eval` считает MRR по десятке. */
  mrrAt10: number
  /** По всей глубине приёмки; отдельным именем, чтобы не путать с публикуемым. */
  mrrAt50: number
  p50ms: number
  p95ms: number
  fingerprint: Record<string, string>
  failures: string[]
}

/**
 * Нижняя граница доверительного интервала Уилсона.
 *
 * Точечная оценка на сотне запросов гуляет на ±10 п.п., и порог по одной точке
 * пропустил бы удачную выборку. Уилсон корректен и на краях диапазона, в отличие
 * от нормального приближения.
 */
export function wilsonLower(hits: number, n: number, z = 1.96): number {
  if (n === 0) return 0
  const p = hits / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (centre - spread) / d)
}

/**
 * Полный SHA и дайджест состояния дерева.
 *
 * Короткого хэша мало: незакоммиченные правки подписались бы чужим коммитом.
 * Счётчика изменённых файлов тоже мало: два разных грязных состояния выглядят
 * одинаково, а именно в грязном состоянии и важно знать, ЧТО именно измерено.
 * Поэтому берётся дайджест патча (индекс плюс рабочее дерево) вместе с хэшами
 * неотслеживаемых файлов — воспроизвести по нему нельзя, но отличить одно
 * состояние от другого можно.
 */
function gitState(): string {
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64e6, ...(input ? { input } : {}) })

  try {
    const sha = git(['rev-parse', 'HEAD']).trim()
    const patch = git(['diff', 'HEAD'])
    const untracked = git(['ls-files', '--others', '--exclude-standard']).trim()
    if (!patch && !untracked) return sha

    // Содержимое неотслеживаемых файлов сворачиваем через git hash-object:
    // читать их самим незачем, а хэши гарантируют, что подмена содержимого
    // изменит дайджест.
    const untrackedHashes = untracked ? git(['hash-object', '--stdin-paths'], `${untracked}\n`) : ''
    return `${sha} + НЕЗАКОММИЧЕННЫЕ ПРАВКИ sha256:${sha256(patch + untracked + untrackedHashes)}`
  } catch {
    return '(вне git)'
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Отпечаток состояния индекса.
 *
 * Демон может переиндексировать репозиторий прямо во время прогона, и тогда
 * первая половина метрик посчитана по одному индексу, вторая по другому,
 * а итог не соответствует ни тому ни другому. Останавливать демона из приёмки
 * неправильно (он может быть чужим процессом), поэтому фиксируем состояние
 * до и после и падаем при расхождении.
 */
async function indexGeneration(repo: string): Promise<string> {
  // Подзапросы, а не два LEFT JOIN от одной таблицы: те давали декартово
  // произведение локаций на файлы (49k × 7k), и приёмка вешалась на первом же
  // замере. Ровно этот дефект уже был в `scs status` — повторять его дважды
  // особенно обидно.
  const { rows } = await db().query<{ locs: number; chunks: number; last: string | null }>(
    `SELECT (SELECT count(*)::int FROM chunk_locations l WHERE l.repo_id = r.id) AS locs,
            (SELECT count(DISTINCT l.content_hash)::int FROM chunk_locations l WHERE l.repo_id = r.id) AS chunks,
            (SELECT max(f.indexed_at)::text FROM files f WHERE f.repo_id = r.id) AS last
       FROM repos r WHERE r.name = $1`,
    [repo],
  )
  const g = rows[0]
  return `${g?.locs ?? 0}/${g?.chunks ?? 0}/${g?.last ?? '—'}`
}

/**
 * Канонический дайджест ВСЕХ настроек, влияющих на выдачу.
 *
 * Перечислять поля руками — значит однажды поменять вес, которого нет в списке,
 * и получить два разных прогона с одинаковым отпечатком. Поэтому хэшируется
 * весь раздел целиком, а в текст выносятся только самые говорящие поля.
 */
function settingsDigest(cfg: ReturnType<typeof loadConfig>, thresholds: AcceptThresholds): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v
  return sha256(JSON.stringify(canonical({ search: cfg.search, chunk: cfg.chunk, thresholds })))
}

export async function runAcceptance(
  repo: string,
  golden: GoldenEntry[],
  goldenPath: string,
  thresholds: AcceptThresholds = FROZEN_THRESHOLDS,
): Promise<AcceptResult> {
  const cfg = loadConfig()
  const modelId = await new Embedder().model()
  const rerankHealth = cfg.search.rerank.enabled ? await new Reranker().health() : null
  const embedHealth = await new Embedder().health()

  // Хэш считается от ТОГО, что оценивается, и ДО прогона. Хэширование файла
  // после цикла подписывало бы результат содержимым, которое могло измениться
  // за время прогона, а при передаче массива, не совпадающего с файлом, —
  // просто чужим содержимым.
  const gitBefore = gitState()
  const indexBefore = await indexGeneration(repo)

  const datasetDigest = sha256(golden.map((g) => `${g.q}\u0000${g.expect.join('\u0001')}`).join('\n'))

  let hit1 = 0
  let hit5 = 0
  let hit10 = 0
  let hit50 = 0
  let mrr10Sum = 0
  let mrr50Sum = 0
  const times: number[] = []

  const keys = (h: { path: string; symbol: string | null; parentChain: string[] }) => [
    h.path,
    ...(h.symbol ? h.symbol.split(',').map((s) => `${h.path}::${s.trim()}`) : []),
    ...h.parentChain.map((p) => `${h.path}::${p}`),
  ]

  let rerankDied: string | null = null
  let searchDied: string | null = null

  for (const entry of golden) {
    const t0 = Date.now()
    // Ни maxPerFile, ни режим не переопределяются «для удобства замера»:
    // берётся ровно то, что настроено в проде, включая defaultMode. Единственное
    // отличие — strictRerank: в проде отказ реранкера означает деградацию
    // выдачи, а в приёмке — что аттестуется не та система. Предварительной
    // проверки /health мало: сервис может упасть на середине прогона.
    let hits
    try {
      hits = await search({ repo, query: entry.q, k: 50, strictRerank: true })
    } catch (err) {
      // Отказ второй ступени и отказ БД или эмбеддера — разные диагнозы,
      // и списывать второе на первое значит искать неисправность не там.
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof Error && err.name === 'RerankUnavailableError') rerankDied = message
      else searchDied = message
      break
    }
    times.push(Date.now() - t0)

    const want = new Set(entry.expect)
    const rank = hits.findIndex((h) => keys(h).some((k) => want.has(k))) + 1
    if (rank > 0) {
      if (rank <= 1) hit1++
      if (rank <= 5) hit5++
      if (rank <= 10) hit10++
      hit50++
      mrr50Sum += 1 / rank
      if (rank <= 10) mrr10Sum += 1 / rank
    }
  }

  const gitAfter = gitState()
  const indexAfter = await indexGeneration(repo)

  const n = golden.length || 1
  times.sort((a, b) => a - b)

  const result: AcceptResult = {
    queries: golden.length,
    recallAt1: hit1 / n,
    recallAt5: hit5 / n,
    recallAt10: hit10 / n,
    recallAt50: hit50 / n,
    wilsonLowerAt5: wilsonLower(hit5, n),
    missingAt50: 1 - hit50 / n,
    mrrAt10: mrr10Sum / n,
    mrrAt50: mrr50Sum / n,
    p50ms: times[Math.floor(times.length * 0.5)] ?? 0,
    p95ms: times[Math.floor(times.length * 0.95)] ?? 0,
    fingerprint: {
      коммит: gitBefore,
      набор: `${goldenPath} (${golden.length} записей) sha256:${datasetDigest}`,
      эмбеддер: `${modelId} (бэкенд ${embedHealth?.backend ?? 'неизвестен'})`,
      индекс: indexBefore,
      реранкер: !cfg.search.rerank.enabled
        ? 'выключен в конфиге'
        : rerankHealth
          ? `${rerankHealth.model} (${rerankHealth.dtype}, ${rerankHealth.device})`
          : 'ВКЛЮЧЁН, НО НЕ ОТВЕЧАЕТ — прогон идёт без второй ступени',
      выдача: `k=50, maxPerFile=${cfg.search.maxPerFile}, режим ${cfg.search.defaultMode} (как в проде)`,
      чанки: `target=${cfg.chunk.targetTokens} max=${cfg.chunk.maxTokens} module=${cfg.chunk.moduleDocInHeader} class=${cfg.chunk.classDocInHeader} callers=${cfg.chunk.callersInHeader}`,
      поиск: `ef=${cfg.search.efSearch} cand=${cfg.search.candidates} docPrior=${cfg.search.docPrior} history=${cfg.search.includeDeleted}`,
      настройки: `sha256:${settingsDigest(cfg, thresholds)} (все поля search и chunk, включая веса, приоритеты и пороги)`,
    },
    failures: [],
  }

  // Недоступный реранкер — это не «чуть хуже», а другая система. Аттестовать
  // её вместо продовой нельзя даже при проходных числах.
  if (cfg.search.rerank.enabled && !rerankHealth) {
    result.failures.push('реранкер включён в конфиге, но не отвечает: аттестована не продовая конфигурация')
  }
  if (searchDied) {
    result.failures.push(`поиск отказал на середине прогона: ${searchDied}. Прогон недействителен.`)
  }
  if (gitAfter !== gitBefore) {
    result.failures.push(
      'рабочее дерево изменилось во время прогона: метрики посчитаны по разным состояниям кода',
    )
  }
  if (indexAfter !== indexBefore) {
    result.failures.push(
      `индекс менялся во время прогона (${indexBefore} → ${indexAfter}): ` +
        'остановите демон и повторите — метрики посчитаны по разным состояниям индекса',
    )
  }
  if (rerankDied) {
    result.failures.push(`реранкер отказал на середине прогона: ${rerankDied}. Прогон недействителен.`)
  }
  if (result.recallAt5 < thresholds.recallAt5) {
    result.failures.push(
      `recall@5 ${(result.recallAt5 * 100).toFixed(1)}% ниже порога ${(thresholds.recallAt5 * 100).toFixed(0)}%`,
    )
  }
  if (result.wilsonLowerAt5 < thresholds.wilsonLowerAt5) {
    result.failures.push(
      `нижняя граница Уилсона ${(result.wilsonLowerAt5 * 100).toFixed(1)}% ниже порога ` +
        `${(thresholds.wilsonLowerAt5 * 100).toFixed(0)}%`,
    )
  }
  if (result.recallAt10 < thresholds.recallAt10) {
    result.failures.push(
      `recall@10 ${(result.recallAt10 * 100).toFixed(1)}% ниже порога ${(thresholds.recallAt10 * 100).toFixed(0)}%`,
    )
  }
  if (result.missingAt50 > thresholds.maxMissingAt50) {
    result.failures.push(
      `ответа нет в топ-50 у ${(result.missingAt50 * 100).toFixed(1)}% запросов при допустимых ` +
        `${(thresholds.maxMissingAt50 * 100).toFixed(0)}%`,
    )
  }

  return result
}

export function formatAcceptance(r: AcceptResult, t: AcceptThresholds): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const out = [
    'ПРИЁМОЧНЫЙ ПРОГОН',
    '',
    'Отпечаток конфигурации:',
    ...Object.entries(r.fingerprint).map(([k, v]) => `  ${k.padEnd(10)} ${v}`),
    '',
    `Запросов: ${r.queries}`,
    `  recall@1   ${pct(r.recallAt1)}`,
    `  recall@5   ${pct(r.recallAt5)}   (порог ${pct(t.recallAt5)})`,
    `  Уилсон@5   ${pct(r.wilsonLowerAt5)}   (порог ${pct(t.wilsonLowerAt5)})`,
    `  recall@10  ${pct(r.recallAt10)}   (порог ${pct(t.recallAt10)})`,
    `  нет в топ-50 ${pct(r.missingAt50)} (порог ${pct(t.maxMissingAt50)})`,
    `  MRR@10     ${r.mrrAt10.toFixed(3)}   (сопоставим с публикуемым)`,
    `  MRR@50     ${r.mrrAt50.toFixed(3)}`,
    `  латентность p50 ${r.p50ms} мс, p95 ${r.p95ms} мс`,
    '',
  ]

  if (r.failures.length) {
    out.push('ПРИЁМКА НЕ ПРОЙДЕНА:')
    for (const f of r.failures) out.push(`  • ${f}`)
    out.push('')
    out.push('Пороги менять нельзя: они заморожены до открытия набора.')
    out.push('Разложите промахи на доступность (нет в топ-50) и ранжирование')
    out.push('(есть в топ-50, но не в топ-5) и возвращайтесь к провалившейся ступени.')
  } else {
    out.push('Приёмка пройдена: все четыре порога соблюдены.')
    out.push('Набор с этого момента считается настроечным — второй раз он ничего не докажет.')
  }
  return out.join('\n')
}
