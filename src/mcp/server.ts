import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, findRepo } from '../config.js'
import { search, findSimilar, type SearchMode } from '../store/search.js'
import { status } from '../store/schema.js'
import { db } from '../store/pool.js'
import { formatHits } from './format.js'

/**
 * MCP-сервер поверх индекса. Транспорт — stdio, поэтому сетевого surface нет вовсе.
 *
 * Один search_code недостаточно: модель регулярно нуждается в уточнении контекста
 * и в понимании структуры незнакомого проекта. Поэтому пять инструментов,
 * и у каждого в описании явно сказано, КОГДА ИМ НЕ ПОЛЬЗОВАТЬСЯ — без этого
 * модель начинает звать семантический поиск там, где точнее grep или LSP.
 */

const cfg = loadConfig()
const defaultRepo = process.env.SCS_REPO ?? cfg.repos[0]?.name ?? ''

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] }
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'scs', version: '0.1.0' })

  server.registerTool(
    'search_code',
    {
      title: 'Семантический поиск по коду',
      description:
        'Найти код по СМЫСЛУ описания, а не по точному имени. Используйте, когда не знаете, ' +
        'как называется искомая функция или файл: «где обрабатывается повторная отправка ' +
        'платежа», «как реализована инвалидация кеша», «что происходит при истечении сессии». ' +
        'Возвращает несколько точных фрагментов с путями и номерами строк вместо чтения файлов ' +
        'целиком. Если имя символа вам ИЗВЕСТНО — используйте Grep, он быстрее и точнее. ' +
        'Для вопросов «кто вызывает эту функцию» и «где она определена» используйте LSP.',
      inputSchema: {
        query: z.string().describe('Описание искомой логики на естественном языке'),
        k: z.number().int().min(1).max(30).optional().describe('Сколько результатов (по умолчанию 8)'),
        repo: z.string().optional().describe('Имя репозитория, если их несколько'),
        path_glob: z
          .string()
          .optional()
          .describe('Ограничить путём, синтаксис SQL LIKE, например packages/queue/%'),
        lang: z.string().optional().describe('typescript | tsx | javascript | jsx'),
        mode: z
          .enum(['hybrid', 'semantic', 'lexical'])
          .optional()
          .describe('semantic по умолчанию (замерено как лучший); hybrid добавляет точные слова'),
      },
    },
    async ({ query, k, repo, path_glob, lang, mode }) => {
      const hits = await search({
        repo: repo ?? defaultRepo,
        query,
        k: k ?? cfg.search.topK,
        mode: mode as SearchMode | undefined,
        pathGlob: path_glob,
        lang,
      })
      return text(formatHits(hits, cfg.search.tokenBudget))
    },
  )

  server.registerTool(
    'find_similar_code',
    {
      title: 'Смысловые дубли фрагмента',
      description:
        'Найти места, где делается ТО ЖЕ САМОЕ, что во фрагменте по указанной позиции — ' +
        'даже если они названы совершенно иначе и лежат в других пакетах. Используйте перед ' +
        'рефакторингом («где ещё в проекте такая же логика ретраев»), при поиске дублей и ' +
        'при переносе правки во все копии. Grep такое не находит принципиально, потому что ' +
        'дубли отличаются именами.',
      inputSchema: {
        path: z.string().describe('Путь к файлу относительно корня репозитория'),
        line: z.number().int().min(1).describe('Любая строка внутри интересующего фрагмента'),
        k: z.number().int().min(1).max(30).optional(),
        repo: z.string().optional(),
        exclude_same_file: z.boolean().optional().describe('По умолчанию true'),
      },
    },
    async ({ path, line, k, repo, exclude_same_file }) => {
      const hits = await findSimilar(
        repo ?? defaultRepo,
        path,
        line,
        k ?? cfg.search.topK,
        exclude_same_file ?? true,
      )
      return text(formatHits(hits, cfg.search.tokenBudget))
    },
  )

  server.registerTool(
    'expand_context',
    {
      title: 'Показать окрестности фрагмента',
      description:
        'Показать конкретный диапазон строк файла с окружением. Существует ровно затем, чтобы ' +
        'не читать файл целиком ради двадцати строк после того, как search_code уже указал ' +
        'нужное место. Если нужен файл целиком — используйте Read.',
      inputSchema: {
        path: z.string(),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1),
        before: z.number().int().min(0).max(200).optional().describe('Строк до (по умолчанию 20)'),
        after: z.number().int().min(0).max(200).optional().describe('Строк после (по умолчанию 20)'),
        repo: z.string().optional(),
      },
    },
    async ({ path, start_line, end_line, before, after, repo }) => {
      const r = findRepo(cfg, repo ?? defaultRepo)
      const src = await readFile(join(r.path, path), 'utf8')
      const lines = src.split('\n')

      const from = Math.max(1, start_line - (before ?? 20))
      const to = Math.min(lines.length, end_line + (after ?? 20))
      const width = String(to).length

      const body = lines
        .slice(from - 1, to)
        .map((l, i) => {
          const n = from + i
          const marker = n >= start_line && n <= end_line ? '>' : ' '
          return `${marker} ${String(n).padStart(width)}  ${l}`
        })
        .join('\n')

      return text(`${path}:${from}-${to}  (искомое помечено «>»)\n${body}`)
    },
  )

  server.registerTool(
    'repo_map',
    {
      title: 'Структура репозитория и экспорты',
      description:
        'Обзор каталогов с количеством файлов и списком экспортируемых символов. Используйте ' +
        'для ориентации в незнакомом проекте ПЕРЕД тем, как искать конкретику: понять, какие ' +
        'вообще есть пакеты и за что каждый отвечает.',
      inputSchema: {
        repo: z.string().optional(),
        path_prefix: z.string().optional().describe('Ограничить поддеревом, например packages/'),
        depth: z.number().int().min(1).max(5).optional().describe('Глубина группировки, по умолчанию 2'),
      },
    },
    async ({ repo, path_prefix, depth }) => {
      const d = depth ?? 2
      const { rows } = await db().query<{ dir: string; files: number; symbols: string[] }>(
        `SELECT array_to_string((string_to_array(l.path, '/'))[1:$3], '/') AS dir,
                count(DISTINCT l.path)::int                                AS files,
                (array_agg(DISTINCT l.symbol) FILTER (WHERE l.exported AND l.symbol IS NOT NULL))[1:25] AS symbols
           FROM chunk_locations l
           JOIN repos r ON r.id = l.repo_id
          WHERE r.name = $1
            AND ($2::text IS NULL OR l.path LIKE $2 || '%')
          GROUP BY dir
          ORDER BY dir`,
        [repo ?? defaultRepo, path_prefix ?? null, d],
      )

      if (!rows.length) return text('Индекс пуст или репозиторий не найден.')

      const out = rows.map(
        (r) =>
          `${r.dir}/  (${r.files} файлов)\n  экспорт: ${(r.symbols ?? []).join(', ') || '—'}`,
      )
      return text(out.join('\n'))
    },
  )

  server.registerTool(
    'index_status',
    {
      title: 'Состояние индекса',
      description:
        'Сколько файлов и чанков проиндексировано и когда. Нужен, чтобы отличить «такого кода ' +
        'в проекте нет» от «индекс устарел и не видит недавние изменения». Проверяйте, если ' +
        'search_code не нашёл того, что вы точно ожидали увидеть.',
      inputSchema: {},
    },
    async () => {
      const s = await status()
      const lines = s.repos.map(
        (r) =>
          `${r.name}: файлов ${r.files}, чанков ${r.chunks}, индексация ${
            r.lastIndexed?.toISOString().replace('T', ' ').slice(0, 19) ?? 'не выполнялась'
          }`,
      )
      return text(
        [
          `модель: ${cfg.embed.model} (${cfg.embed.backend})`,
          `уникальных векторов: ${s.totalChunks}`,
          ...lines,
        ].join('\n'),
      )
    },
  )

  return server
}

export async function runStdio(): Promise<void> {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}
