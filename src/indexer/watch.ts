import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { join, relative, sep } from 'node:path'
import type { RepoConfig } from '../config.js'
import { loadConfig } from '../config.js'
import { Embedder } from '../embed/client.js'
import { indexPaths, indexRepo } from './scan.js'
import { PathQueue } from './queue.js'

/**
 * Watch-режим: правка файла видна в поиске за секунды, без ручного `scs index`.
 *
 * Два независимых источника событий, и это не дублирование:
 *
 * - **Файлы рабочего дерева** — обычная работа в редакторе. Реагируем точечно.
 * - **`.git/HEAD` и `.git/index`** — checkout, rebase, stash, merge. Тут
 *   меняются сотни файлов сразу, и поштучные события от chokidar пришли бы
 *   лавиной. Дешевле сделать один полный диф по `git ls-files -s`: он читает
 *   не файлы, а индекс git, и на монорепе занимает миллисекунды.
 */

export interface WatchOptions {
  /** Сколько ждать затишья перед обработкой пачки. */
  debounceMs?: number
  /** Выше этого числа путей выгоднее полный диф, чем поштучная обработка. */
  maxPaths?: number
  onEvent?: (msg: string) => void
}

export interface RepoWatcher {
  stop: () => Promise<void>
}

export async function watchRepo(repo: RepoConfig, opts: WatchOptions = {}): Promise<RepoWatcher> {
  const cfg = loadConfig()
  const log = opts.onEvent ?? (() => {})
  const debounceMs = opts.debounceMs ?? 500
  const maxPaths = opts.maxPaths ?? 500

  // Один эмбеддер на весь демон: он кэширует идентификатор модели, и без этого
  // каждая правка ходила бы в /health.
  const embedder = new Embedder()
  const modelId = await embedder.model()

  const queue = new PathQueue({
    debounceMs,
    maxPaths,
    onFlush: async (paths, reason) => {
      const started = Date.now()
      try {
        if (reason === 'overflow') {
          const r = await indexRepo(repo)
          log(
            `${repo.name}: полный диф (накопилось ${paths.length} путей) — ` +
              `изменено ${r.changed}, удалено ${r.deleted}, ${(r.ms / 1000).toFixed(1)} с`,
          )
          return
        }
        const r = await indexPaths(repo, paths, { modelId, embedder })
        if (r.changed || r.deleted) {
          log(
            `${repo.name}: ${r.changed} изменено, ${r.deleted} удалено, ` +
              `чанков ${r.chunks} (векторов ${r.embedded}, переиспользовано ${r.reused}), ` +
              `${Date.now() - started} мс`,
          )
        }
      } catch (err) {
        // Демон живёт долго; упасть из-за одной неудачной правки он не должен.
        log(`${repo.name}: ОШИБКА обработки — ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  const rel = (path: string) => relative(repo.path, path).split(sep).join('/')

  const files: FSWatcher = chokidarWatch(repo.path, {
    ignoreInitial: true,
    // Иначе поймаем частично записанный файл от сборщика и проиндексируем мусор.
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    ignored: (path) => {
      const r = rel(path)
      // .git отслеживается отдельным watcher'ом: события из него — это не правки
      // файлов, а смена состояния репозитория целиком.
      return r.startsWith('.git/') || r === '.git' || r.includes('/node_modules/') || r.startsWith('node_modules/')
    },
  })

  for (const event of ['add', 'change', 'unlink'] as const) {
    files.on(event, (path: string) => queue.add(rel(path)))
  }

  // git-события: один полный диф вместо лавины поштучных.
  const gitQueue = new PathQueue({
    debounceMs: 1000,
    maxPaths: 1,
    onFlush: async () => {
      const started = Date.now()
      try {
        const r = await indexRepo(repo)
        log(
          `${repo.name}: смена состояния git — изменено ${r.changed}, удалено ${r.deleted}, ` +
            `векторов ${r.embedded}, переиспользовано ${r.reused}, ${((Date.now() - started) / 1000).toFixed(1)} с`,
        )
      } catch (err) {
        log(`${repo.name}: ОШИБКА полного дифа — ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  const gitFiles: FSWatcher = chokidarWatch(
    [join(repo.path, '.git', 'HEAD'), join(repo.path, '.git', 'index')],
    { ignoreInitial: true },
  )
  for (const event of ['add', 'change'] as const) {
    gitFiles.on(event, () => gitQueue.add('git'))
  }

  log(`${repo.name}: слежу за ${repo.path} (дебаунс ${debounceMs} мс, порог ${maxPaths})`)
  if (cfg.deny.length) log(`${repo.name}: дополнительный deny-list из конфига: ${cfg.deny.length} шаблонов`)

  return {
    stop: async () => {
      queue.stop()
      gitQueue.stop()
      await files.close()
      await gitFiles.close()
    },
  }
}
