#!/usr/bin/env node
import { Command } from 'commander'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { migrate, status } from '../store/schema.js'
import { closeDb } from '../store/pool.js'
import { loadConfig, configPath, findRepo } from '../config.js'
import { indexRepo } from '../indexer/scan.js'
import { search, findSimilar, type SearchMode } from '../store/search.js'
import { gc } from '../store/chunks.js'
import { formatHits } from '../mcp/format.js'
import { evaluate, formatResults, loadGolden } from '../eval/run.js'
import { measureDepth, formatDepth } from '../eval/depth.js'
import { exportChunks, importChunks } from '../store/transfer.js'
import { indexHistory } from '../indexer/history.js'
import { loadChains, measureCollapse, formatCollapse } from '../eval/collapse.js'
import { checkIndex, formatHealth, indexProblems } from '../store/doctor.js'
import { runAcceptance, formatAcceptance, FROZEN_THRESHOLDS } from '../eval/accept.js'
import { packageRoot } from '../util/root.js'
import { UNITS, findCudaLibs, renderUnit } from '../setup/units.js'

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
    // Две даты, а не одна: полный проход отвечает «когда индексировали всё»,
    // а правка — «до какого момента индекс видит изменения». При работающем
    // демоне вторая уходит вперёд, и путать их значит считать индекс устаревшим.
    console.log('\nрепозиторий           файлов   чанков  история  правка в индексе     полный проход')
    for (const r of s.repos) {
      const when = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) : '—')
      console.log(
        `${r.name.padEnd(20)} ${String(r.files).padStart(7)} ${String(r.chunks).padStart(8)} ` +
          `${String(r.history || '—').padStart(8)}  ${when(r.lastChange).padEnd(19)}  ${when(r.lastIndexed)}`,
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
  .option('--lang <lang>', 'typescript | tsx | javascript | jsx | markdown | mdx')
  .option('--history', 'искать и по удалённым файлам из истории git')
  .action(
    async (
      name: string,
      queryParts: string[],
      opts: { top: string; mode: string; path?: string; lang?: string; history?: boolean },
    ) => {
      const hits = await search({
        repo: name,
        query: queryParts.join(' '),
        k: Number(opts.top),
        mode: (opts.mode || undefined) as SearchMode | undefined,
        pathGlob: opts.path,
        lang: opts.lang,
        includeDeleted: opts.history,
      })
      console.log(formatHits(hits, loadConfig().search.tokenBudget))
    },
  )

program
  .command('similar <repo> <path> <line>')
  .description('найти смысловые дубли фрагмента')
  .option('-k, --top <n>', 'сколько результатов', '8')
  .option('--same-file', 'не исключать тот же файл')
  .option('--history', 'искать дубли и среди удалённых файлов из истории git')
  .action(
    async (
      name: string,
      path: string,
      line: string,
      opts: { top: string; sameFile?: boolean; history?: boolean },
    ) => {
      const hits = await findSimilar(
        name,
        path,
        Number(line),
        Number(opts.top),
        !opts.sameFile,
        opts.history,
      )
      console.log(formatHits(hits, loadConfig().search.tokenBudget))
    },
  )

program
  .command('eval <repo>')
  .description('измерить качество поиска на golden-наборе')
  .option('--golden <path>', 'файл .jsonl с запросами', '')
  .option('--mode <modes>', 'режимы через запятую', 'hybrid,semantic,lexical')
  .option('--unseal', 'открыть отложенный набор (только один раз, после заморозки конфигурации)')
  .action(async (name: string, opts: { golden: string; mode: string; unseal?: boolean }) => {
    const path = opts.golden || `src/eval/golden.${name}.jsonl`
    const golden = loadGolden(path, { unseal: opts.unseal })
    const modes = opts.mode.split(',').map((m) => m.trim() as SearchMode)

    const results = []
    for (const mode of modes) results.push(await evaluate(name, golden, mode))
    console.log(formatResults(results, golden.length))
  })

program
  .command('depth <repo>')
  .description('ранг ожидаемого ответа в векторной выдаче: провал полноты или ранжирования')
  .option('--golden <path>', 'файл .jsonl с запросами', '')
  .option('--depth <n>', 'до какой глубины искать ответ', '300')
  .option('--unseal', 'открыть отложенный набор')
  .action(async (name: string, opts: { golden: string; depth: string; unseal?: boolean }) => {
    const golden = loadGolden(opts.golden || `src/eval/golden.${name}.jsonl`, {
      unseal: opts.unseal,
    })
    const depth = Number(opts.depth)
    console.log(formatDepth([await measureDepth(name, golden, depth)], depth))
  })

program
  .command('collapse <repo>')
  .description('сколько вызовов инструментов заменяет один search_code (цепочки из транскриптов)')
  .option('--chains <path>', 'файл .jsonl с цепочками', '')
  .option('-k, --top <n>', 'глубина, на которой считаем цепочку схлопнувшейся', '5')
  .action(async (name: string, opts: { chains: string; top: string }) => {
    const chains = loadChains(opts.chains || `src/eval/chains.${name}.jsonl`)
    const k = Number(opts.top)
    console.log(formatCollapse(await measureCollapse(name, chains, k), k))
  })

program
  .command('history <repo>')
  .description('проиндексировать удалённые файлы из истории git (отдельный режим)')
  .option('--depth <n>', 'сколько коммитов истории просматривать', '500')
  .action(async (name: string, opts: { depth: string }) => {
    const r = await indexHistory(findRepo(loadConfig(), name), {
      depth: Number(opts.depth),
      onProgress: (done, total, path) => {
        if (done % 10 === 0 || done === total) {
          process.stderr.write(`\r  ${done}/${total}  ${path.slice(-60).padEnd(60)}`)
        }
      },
    })
    process.stderr.write('\r'.padEnd(80) + '\r')
    console.log(
      [
        `удалённых файлов найдено: ${r.candidates}`,
        `проиндексировано: ${r.indexed}, пропущено: ${r.skipped}`,
        `чанков: ${r.chunks} (векторов ${r.embedded}, переиспользовано ${r.reused})`,
        `время: ${(r.ms / 1000).toFixed(1)} с`,
        `Найденное помечается префиксом @deleted/ и понижается в ранжировании.`,
      ].join('\n'),
    )
  })

program
  .command('export <file>')
  .description('выгрузить посчитанные вектора для переноса на другую машину')
  .option('--repo <name>', 'только чанки этого репозитория')
  .option('--model <id>', 'только этой модели')
  .action(async (file: string, opts: { repo?: string; model?: string }) => {
    const s = await exportChunks(file, { repo: opts.repo, model: opts.model })
    console.log(
      `Выгружено чанков: ${s.chunks}, ${(s.bytes / 1024 / 1024).toFixed(1)} МБ, ` +
        `${(s.ms / 1000).toFixed(1)} с\nЛокации там не нужны: на новой машине их пересоберёт scs index.`,
    )
  })

program
  .command('import <file>')
  .description('загрузить вектора, посчитанные на другой машине')
  .action(async (file: string) => {
    const s = await importChunks(file)
    console.log(
      `Загружено новых: ${s.chunks}, уже было: ${s.skipped}, ${(s.ms / 1000).toFixed(1)} с\n` +
        `Дальше: scs index <repo> — он соберёт локации и не пересчитает ни одного вектора.`,
    )
  })

program
  .command('doctor <repo>')
  .description('здоровье индекса: сверка приближённой выдачи с точным перебором')
  .option('--golden <path>', 'файл .jsonl с запросами', '')
  .option('--unseal', 'открыть отложенный набор')
  .action(async (name: string, opts: { golden: string; unseal?: boolean }) => {
    const golden = loadGolden(opts.golden || `src/eval/golden.${name}.jsonl`, {
      unseal: opts.unseal,
    })
    const health = await checkIndex(name, golden)
    console.log(formatHealth(health))
    // Молчаливый успех при найденных проблемах делает команду бесполезной
    // в конвейере: её зовут именно затем, чтобы остановить выпуск.
    if (indexProblems(health).length) process.exitCode = 1
  })

program
  .command('accept <repo>')
  .description('приёмочный прогон: замороженные пороги, отпечаток конфигурации, код возврата')
  .requiredOption('--golden <path>', 'набор, по которому принимаем')
  .option('--unseal', 'открыть отложенный набор — делается ОДИН раз')
  .action(async (name: string, opts: { golden: string; unseal?: boolean }) => {
    const golden = loadGolden(opts.golden, { unseal: opts.unseal })
    const result = await runAcceptance(name, golden, opts.golden)
    console.log(formatAcceptance(result, FROZEN_THRESHOLDS))
    if (result.failures.length) process.exitCode = 1
  })

program
  .command('setup')
  .description('установить systemd-юниты служб под пути этой машины')
  .option('--boot', 'поднимать службы при загрузке ОС, а не при входе в систему')
  .option('--dry-run', 'показать, что будет записано, и ничего не делать')
  .action((opts: { boot?: boolean; dryRun?: boolean }) => {
    const root = packageRoot()
    if (!existsSync(join(root, 'dist'))) {
      throw new Error('нет каталога dist — сначала npm run build')
    }

    // Реранкер при загрузке ОС занимал бы 2+ ГБ видеопамяти на машине, за которой
    // никто не сидит. Индексации это не мешает: она обходится без него.
    const SESSION_TARGET = 'graphical-session.target'
    const vars = {
      node: process.execPath,
      root,
      cudaLibs: findCudaLibs(root),
      wantedBy: opts.boot ? SESSION_TARGET : 'default.target',
      sessionBinding: opts.boot ? SESSION_TARGET : undefined,
    }

    const target = join(homedir(), '.config', 'systemd', 'user')
    const rendered = UNITS.map((name) => ({
      name,
      file: `${name}.service`,
      body: renderUnit(readFileSync(join(root, 'packaging', `${name}.service.in`), 'utf8'), vars),
    }))

    if (opts.dryRun) {
      for (const u of rendered) console.log(`--- ${join(target, u.file)} ---\n${u.body}`)
      return
    }

    mkdirSync(target, { recursive: true })
    for (const u of rendered) writeFileSync(join(target, u.file), u.body)

    const sysctl = (...args: string[]) =>
      execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
    sysctl('daemon-reload')
    // disable перед enable, иначе смена цели автозапуска не отменяет прежнюю:
    // symlink на default.target.wants остаётся, и реранкер продолжает подниматься
    // при загрузке ОС, занимая видеопамять, — ровно то, ради чего затевался --boot.
    // Службы при этом не останавливаются: --now здесь не передаётся.
    sysctl('disable', ...UNITS)
    sysctl('enable', ...UNITS)

    // Запускаем сами, а не через `enable --now`: тот поднял бы реранкер
    // независимо от того, есть ли графическая сессия. При установке по ssh
    // на машине без сессии это заняло бы два гигабайта видеопамяти — как раз
    // тот расход, которого режим --boot и должен избегать.
    const sessionActive = (() => {
      try {
        execFileSync('systemctl', ['--user', 'is-active', '--quiet', SESSION_TARGET])
        return true
      } catch {
        return false
      }
    })()

    for (const name of UNITS) {
      const sessionOnly = opts.boot && name === 'scs-rerank'
      if (sessionOnly && !sessionActive) sysctl('stop', name)
      else sysctl('start', name)
    }

    if (opts.boot) {
      // Без linger пользовательский менеджер systemd стартует при первом входе
      // в систему и гаснет с последней сессией: enable юниту не поможет.
      execFileSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'inherit' })
    }

    console.log(
      [
        `Установлено юнитов: ${rendered.length} → ${target}`,
        `node:  ${vars.node}`,
        `корень: ${vars.root}`,
        vars.cudaLibs.length
          ? `CUDA:  найдено каталогов ${vars.cudaLibs.length} — реранкер пойдёт на GPU`
          : 'CUDA:  не найдена — реранкер пойдёт на CPU, в 20 раз медленнее (npm run cuda:libs)',
        opts.boot
          ? 'Автозапуск: при загрузке ОС; реранкер — только на время сессии.'
          : 'Автозапуск: при входе в систему. Чтобы поднимались до входа — scs setup --boot',
        'Проверка: scs status',
      ].join('\n'),
    )
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
