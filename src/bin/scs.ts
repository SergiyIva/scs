#!/usr/bin/env node
import { Command } from 'commander'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migrate, status } from '../store/schema.js'
import { closeDb } from '../store/pool.js'
import { loadConfig, configPath, findRepo } from '../config.js'
import { indexRepo } from '../indexer/scan.js'
import { search, findSimilar, type SearchMode } from '../store/search.js'
import { gc } from '../store/chunks.js'
import { formatHits } from '../mcp/format.js'
import { evaluate, formatResults, loadGolden } from '../eval/run.js'

const program = new Command()
program.name('scs').description('Семантический поиск по коду').version('0.1.0')

program
  .command('migrate')
  .description('применить миграции БД')
  .action(async () => {
    const applied = await migrate()
    console.log(applied.length ? `Применено: ${applied.join(', ')}` : 'Миграции уже применены.')
  })

program
  .command('status')
  .description('состояние БД и индекса')
  .action(async () => {
    const cfg = loadConfig()
    console.log(`конфиг:   ${configPath()}`)
    console.log(`postgres: ${cfg.pg.replace(/:[^:@]*@/, ':***@')}`)
    console.log(`эмбеддер: ${cfg.embed.url} (${cfg.embed.backend}, ${cfg.embed.model})`)

    const s = await status()
    console.log(`миграции: ${s.migrations.join(', ') || '(нет)'}`)
    console.log(`уникальных чанков: ${s.totalChunks}`)

    if (!s.repos.length) {
      console.log('\nРепозиториев нет. Добавьте: scs repo add <path> --name <name>')
      return
    }
    console.log('\nрепозиторий           файлов   чанков  последняя индексация')
    for (const r of s.repos) {
      const when = r.lastIndexed ? r.lastIndexed.toISOString().replace('T', ' ').slice(0, 19) : '—'
      console.log(
        `${r.name.padEnd(20)} ${String(r.files).padStart(7)} ${String(r.chunks).padStart(8)}  ${when}`,
      )
    }
  })

const repo = program.command('repo').description('управление репозиториями')

repo
  .command('add <path>')
  .description('зарегистрировать репозиторий в конфиге')
  .requiredOption('--name <name>', 'короткое имя')
  .action((path: string, opts: { name: string }) => {
    const file = configPath()
    const cfg: { repos?: { name: string; path: string; watch: boolean }[] } = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : {}
    cfg.repos ??= []

    const abs = resolve(path)
    const existing = cfg.repos.findIndex((r) => r.name === opts.name)
    const entry = { name: opts.name, path: abs, watch: true }
    if (existing >= 0) cfg.repos[existing] = entry
    else cfg.repos.push(entry)

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)
    console.log(`Зарегистрирован "${opts.name}" → ${abs}\nДалее: scs index ${opts.name}`)
  })

program
  .command('index <repo>')
  .description('проиндексировать репозиторий')
  .option('--full', 'переиндексировать всё, игнорируя blob sha в БД')
  .action(async (name: string, opts: { full?: boolean }) => {
    const cfg = loadConfig()
    const r = findRepo(cfg, name)

    const report = await indexRepo(r, {
      full: opts.full,
      onProgress: (done, total, path) => {
        if (done % 25 === 0 || done === total) {
          process.stderr.write(`\r  ${done}/${total}  ${path.slice(-60).padEnd(60)}`)
        }
      },
    })
    process.stderr.write('\r'.padEnd(80) + '\r')

    console.log(
      [
        `файлов просмотрено: ${report.scanned}`,
        `изменилось: ${report.changed}, удалено: ${report.deleted}, пропущено: ${report.skipped}`,
        `чанков: ${report.chunks} (посчитано векторов ${report.embedded}, переиспользовано ${report.reused})`,
        `обрезано по контексту модели: ${(report.truncationRate * 100).toFixed(1)}%`,
        `время: ${(report.ms / 1000).toFixed(1)} с`,
      ].join('\n'),
    )
    if (report.truncationRate > 0.05) {
      console.log('\nВНИМАНИЕ: больше 5% чанков упёрлись в контекст модели — чанкер режет плохо.')
    }
  })

program
  .command('search <repo> <query...>')
  .description('семантический поиск')
  .option('-k, --top <n>', 'сколько результатов', '8')
  .option('-m, --mode <mode>', 'semantic | hybrid | lexical', '')
  .option('--path <glob>', 'фильтр по пути (SQL LIKE, например src/%)')
  .option('--lang <lang>', 'фильтр по языку')
  .action(
    async (
      name: string,
      queryParts: string[],
      opts: { top: string; mode: string; path?: string; lang?: string },
    ) => {
      const hits = await search({
        repo: name,
        query: queryParts.join(' '),
        k: Number(opts.top),
        mode: (opts.mode || undefined) as SearchMode | undefined,
        pathGlob: opts.path,
        lang: opts.lang,
      })
      console.log(formatHits(hits, loadConfig().search.tokenBudget))
    },
  )

program
  .command('similar <repo> <path> <line>')
  .description('найти смысловые дубли фрагмента')
  .option('-k, --top <n>', 'сколько результатов', '8')
  .option('--same-file', 'не исключать тот же файл')
  .action(
    async (name: string, path: string, line: string, opts: { top: string; sameFile?: boolean }) => {
      const hits = await findSimilar(name, path, Number(line), Number(opts.top), !opts.sameFile)
      console.log(formatHits(hits, loadConfig().search.tokenBudget))
    },
  )

program
  .command('eval <repo>')
  .description('измерить качество поиска на golden-наборе')
  .option('--golden <path>', 'файл .jsonl с запросами', '')
  .option('--mode <modes>', 'режимы через запятую', 'hybrid,semantic,lexical')
  .action(async (name: string, opts: { golden: string; mode: string }) => {
    const path = opts.golden || `src/eval/golden.${name}.jsonl`
    const golden = loadGolden(path)
    const modes = opts.mode.split(',').map((m) => m.trim() as SearchMode)

    const results = []
    for (const mode of modes) results.push(await evaluate(name, golden, mode))
    console.log(formatResults(results, golden.length))
  })

program
  .command('gc')
  .description('удалить чанки, на которые никто не ссылается')
  .action(async () => {
    console.log(`Удалено осиротевших чанков: ${await gc()}`)
  })

async function main() {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}

void main()
