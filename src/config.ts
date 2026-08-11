import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

/** Размерность вектора зашита в migrations/001_init.sql и не может меняться конфигом. */
export const VECTOR_DIMS = 768

const RepoConfig = z.object({
  name: z.string().min(1),
  path: z.string().transform((p) => resolve(p.replace(/^~/, homedir()))),
  watch: z.boolean().default(true),
})

// ВНИМАНИЕ: у вложенных объектов используется .prefault({}), а не .default({}).
// В zod v4 .default() возвращает значение как есть, без парсинга, поэтому дефолты
// внутренних полей не применились бы и cfg.embed.url оказался бы undefined.
// .prefault() подставляет значение ДО парсинга и восстанавливает поведение v3.
const ConfigSchema = z.object({
  pg: z.string().default('postgres://scs:scs@127.0.0.1:5434/scs'),
  embed: z
    .object({
      url: z.string().default('http://127.0.0.1:8077'),
      backend: z.enum(['ollama', 'npu']).default('ollama'),
      model: z.string().default('embeddinggemma:300m'),
      dims: z.literal(VECTOR_DIMS).default(VECTOR_DIMS),
      batchSize: z.number().int().positive().default(64),
    })
    .prefault({}),
  chunk: z
    .object({
      minTokens: z.number().int().positive().default(40),
      // 500 — лучший измеренный компромисс на unitify (RECALL85 §4.5, D):
      // recall@5 при 200/300/500/700 = 46.6/44.8/51.7/44.8%, то есть кривая
      // с максимумом, а не край диапазона. Не «победа по всем осям»: у 300
      // лучше recall@10 (58.6% против 56.9%), у 700 и 800 меньше векторов,
      // а перевес по @5 над 300 — четыре запроса из 58, и его устойчивость
      // не установлена. Выбор опирается на @5, MRR, разнообразие выдачи
      // и размер индекса вместе.
      targetTokens: z.number().int().positive().default(500),
      maxTokens: z.number().int().positive().default(700),
      headerBudget: z.number().int().positive().default(120),
      // Назначение файла и класса в заголовке чанка (эксперимент A/B, §4.5).
      // Обе строки одинаковы для всех чанков файла или класса, поэтому дают
      // и пользу (мост «механизм → роль в сценарии»), и вред (склейка выдачи
      // в один файл). Разделены, чтобы мерить по отдельности; смена значения
      // меняет content_hash и потому автоматически обесценивает индекс.
      // Замерено раздельно на unitify при target 500 и выключенном реранкере
      // (RECALL85 §4.5, повтор на ИСПРАВЛЕННОЙ семантике модульного JSDoc):
      // назначение файла даёт @1 17.2% → 22.4% и MRR 0.304 → 0.348, а JSDoc
      // класса в отдельности неотличим от его отсутствия, при этом склейку
      // выдачи всё же ухудшает. Поэтому включён первый и выключен второй;
      // флаг оставлен, потому что на объектно-ориентированном корпусе
      // результат может быть иным — в unitify классы редки.
      moduleDocInHeader: z.boolean().default(true),
      classDocInHeader: z.boolean().default(false),
      // Остальные строки заголовка. Все три ОДИНАКОВЫ для всех чанков файла,
      // то есть подозреваются и в пользе, и в склейке выдачи. Их вклад мерился
      // только на корпусе из 170 чанков (§9 DESIGN), то есть фактически не мерился.
      pathWordsInHeader: z.boolean().default(true),
      importsInHeader: z.boolean().default(true),
      exportsInHeader: z.boolean().default(true),
      // Эксперимент C: имена вызывающих в заголовке. Назначение фрагмента часто
      // известно не ему самому, а тому, кто его зовёт. Выключено по умолчанию
      // до замера: правка вызывающего меняет content_hash вызываемого, то есть
      // это транзитивная инвалидация, и цену надо знать заранее.
      callersInHeader: z.boolean().default(false),
    })
    .prefault({}),
  search: z
    .object({
      topK: z.number().int().positive().default(8),
      // Умолчание — чистый вектор, а не гибрид. Это ИЗМЕРЕНО, а не выбрано:
      // на трёх golden-наборах (см. docs/DESIGN.md §9) лексическая ветка ни разу
      // не выиграла и дважды заметно проиграла, в том числе на наборе из одних
      // идентификаторов, где она обязана была быть сильной.
      // Пересмотреть после замера на настоящей монорепе: там у вектора будет
      // на порядки больше поводов запутаться.
      defaultMode: z.enum(['hybrid', 'semantic', 'lexical']).default('semantic'),
      candidates: z.number().int().positive().default(50),
      // hnsw.ef_search для векторной ветки. Умолчание pgvector — 40, и на
      // корпусе в 40k чанков оно даёт лишь 69% совпадения с точным перебором.
      // 200 даёт 97% за 5 мс, 600 — 100% за 80 мс. Замер в docs/DESIGN.md §17.
      efSearch: z.number().int().positive().default(200),
      rrfK: z.number().int().positive().default(60),
      maxPerFile: z.number().int().positive().default(2),
      tokenBudget: z.number().int().positive().default(4000),
      // Вес ветвей при RRF-слиянии. Лексика ниже вектора: она хорошо ловит
      // точные идентификаторы, но на запросе в свободной форме шумит.
      vectorWeight: z.number().positive().default(1),
      lexicalWeight: z.number().positive().default(0.5),
      // Карточка файла — синтезированная нами сводка, а не код. Она короткая и
      // плотно набита идентификаторами, поэтому ts_rank её систематически
      // переоценивает и она вытесняет настоящую реализацию из топа.
      fileCardPrior: z.number().positive().default(0.6),
      // Безымянный кусок — это промежуток между объявлениями или мелкая привязка.
      // После ремонта чанкера (§19) таких стало много, и они полезли в верх
      // выдачи: recall@1 просел с 8.6% до 5.2%. Ответом на вопрос «как это
      // работает» такой кусок бывает редко — у него нет даже имени.
      unnamedPrior: z.number().positive().default(0.7),
      // Документация отвечает на вопрос «как устроено вообще», но вытесняет код
      // с первого места вдвое чаще, чем помогает (§17): 31.6% топ-10.
      docPrior: z.number().positive().default(0.7),
      // Cross-encoder реранкер. Bi-encoder отбирает из десятков тысяч, но между
      // «ответ в первых 50» (67.2%) и «ответ в первых 5» (37.9%) лежат 29 п.п.
      // порядка, а не полноты (§19). Даёт +8.7 п.п. к recall@5 за 250 мс на GPU.
      // Включён по умолчанию: если сервис не поднят, поиск продолжает работать
      // в прежнем порядке, о чём клиент пишет в stderr.
      rerank: z
        .object({
          enabled: z.boolean().default(true),
          url: z.string().default('http://127.0.0.1:8090'),
          // Сколько кандидатов отдаём cross-encoder'у. Больше — выше шанс достать
          // ответ снизу, но стоимость линейна по числу пар.
          // 20 замерено как оптимум: качество как у 30, но на треть быстрее (§20).
          candidates: z.number().int().positive().default(20),
          timeoutMs: z.number().int().positive().default(15000),
          // 'replace' — порядок задаёт только cross-encoder; 'rrf' — слияние
          // с порядком эмбеддера по рангам. Замер §20: замена поднимает recall@5,
          // но роняет recall@1, потому что сдвигает уверенный первый результат.
          fusion: z.enum(['replace', 'rrf']).default('rrf'),
          // Вес ветви cross-encoder при RRF-слиянии. 0.5 — единственное значение,
          // которое улучшает recall@5 и не ухудшает ни @1, ни @10 (§20).
          weight: z.number().positive().default(0.5),
        })
        .prefault({}),
      // Код из истории git (§21) по умолчанию НЕ участвует в поиске.
      // Понижающего множителя оказалось мало: замерено, что присутствие истории
      // в общем пространстве стоит 1.8 п.п. recall@5 на живом коде. История —
      // ответ на отдельный вопрос («а как было до рефакторинга»), поэтому она
      // включается параметром запроса, а не размывает обычную выдачу.
      includeDeleted: z.boolean().default(false),
      // Применяется, только когда история включена явно.
      deletedPrior: z.number().positive().default(0.5),
      // Понижающие множители по шаблону пути (идея из grepai). Тест или фикстура
      // почти никогда не является ответом на вопрос «как это работает», но
      // лексически и семантически конкурирует с реализацией на равных.
      penalties: z
        .array(z.object({ pattern: z.string(), factor: z.number().positive() }))
        .default([
          { pattern: '**/*.test.*', factor: 0.4 },
          { pattern: '**/*.spec.*', factor: 0.4 },
          { pattern: '**/test/**', factor: 0.5 },
          { pattern: '**/tests/**', factor: 0.5 },
          { pattern: '**/__tests__/**', factor: 0.5 },
          { pattern: '**/__mocks__/**', factor: 0.4 },
          { pattern: '**/fixtures/**', factor: 0.4 },
          { pattern: '**/examples/**', factor: 0.6 },
        ]),
    })
    .prefault({}),
  repos: z.array(RepoConfig).default([]),
  deny: z.array(z.string()).default([]),
  respectGitignore: z.boolean().default(true),
})

export type Config = z.infer<typeof ConfigSchema>
export type RepoConfig = z.infer<typeof RepoConfig>

export function configPath(): string {
  return process.env.SCS_CONFIG ?? join(homedir(), '.config', 'scs', 'config.json')
}

let cached: Config | undefined

export function loadConfig(): Config {
  if (cached) return cached

  const path = configPath()
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Некорректный конфиг ${path}:\n${issues.join('\n')}`)
  }

  const cfg = parsed.data
  // Env перекрывает файл — удобно для systemd-юнита и для MCP-сервера.
  if (process.env.SCS_PG) cfg.pg = process.env.SCS_PG
  if (process.env.SCS_EMBED_URL) cfg.embed.url = process.env.SCS_EMBED_URL

  cached = cfg
  return cfg
}

export function findRepo(cfg: Config, name: string): RepoConfig {
  const repo = cfg.repos.find((r) => r.name === name)
  if (!repo) {
    const known = cfg.repos.map((r) => r.name).join(', ') || '(ни одного)'
    throw new Error(`Репозиторий "${name}" не зарегистрирован. Известные: ${known}`)
  }
  return repo
}
