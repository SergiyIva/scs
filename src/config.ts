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
      targetTokens: z.number().int().positive().default(300),
      maxTokens: z.number().int().positive().default(700),
      headerBudget: z.number().int().positive().default(120),
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
