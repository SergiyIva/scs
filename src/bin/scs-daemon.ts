#!/usr/bin/env node
import { loadConfig } from '../config.js'
import { watchRepo, type RepoWatcher } from '../indexer/watch.js'
import { closeDb } from '../store/pool.js'

/**
 * Демон инкрементальной индексации.
 *
 * Существует ради одного свойства: индекс не должен молча устаревать. Устаревший
 * индекс хуже отсутствующего — агент получает уверенный ответ про код, которого
 * уже нет, и не имеет способа это заметить.
 *
 * Запускается user-level systemd-юнитом (packaging/scs-daemon.service).
 * Пишет в stdout, логи собирает journald.
 */

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const repos = cfg.repos.filter((r) => r.watch)

  if (!repos.length) {
    console.error('Нет репозиториев с watch: true — демону нечего делать.')
    process.exitCode = 1
    return
  }

  const watchers: RepoWatcher[] = []
  const log = (msg: string) => console.log(`${stamp()}  ${msg}`)

  for (const repo of repos) {
    try {
      watchers.push(await watchRepo(repo, { onEvent: log }))
    } catch (err) {
      // Один недоступный репозиторий не должен ронять слежение за остальными.
      log(`${repo.name}: не удалось начать слежение — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!watchers.length) {
    console.error('Ни за одним репозиторием следить не удалось.')
    process.exitCode = 1
    return
  }

  const shutdown = async (signal: string) => {
    log(`получен ${signal}, останавливаюсь`)
    await Promise.allSettled(watchers.map((w) => w.stop()))
    await closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  log(`демон запущен, репозиториев под слежением: ${watchers.length}`)
}

void main()
