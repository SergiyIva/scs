import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig } from '../config.js'
import { loadConfig } from '../config.js'
import { chunkFile } from '../chunker/index.js'
import { Embedder } from '../embed/client.js'
import { listFiles, hashWorkingFiles, headCommit, isGitRepo } from './git.js'
import { makeFilter, looksIndexable } from './deny.js'
import { upsertRepo, markIndexed } from '../store/repos.js'
import { commitFile, deleteFile, knownFiles, missingHashes, prepare } from '../store/chunks.js'
import { DELETED_PREFIX } from './history.js'

export interface IndexReport {
  scanned: number
  changed: number
  deleted: number
  skipped: number
  chunks: number
  embedded: number
  reused: number
  truncationRate: number
  ms: number
}

export interface IndexOptions {
  full?: boolean
  onProgress?: (done: number, total: number, path: string) => void
}

function emptyReport(): IndexReport {
  return {
    scanned: 0,
    changed: 0,
    deleted: 0,
    skipped: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    truncationRate: 0,
    ms: 0,
  }
}

export async function indexRepo(repo: RepoConfig, opts: IndexOptions = {}): Promise<IndexReport> {
  const started = Date.now()
  const cfg = loadConfig()

  if (!(await isGitRepo(repo.path))) {
    throw new Error(`${repo.path} не является git-репозиторием (нужен для дешёвого дифа)`)
  }

  const embedder = new Embedder()
  const modelId = await embedder.model()

  const row = await upsertRepo(repo.name, repo.path)
  const filter = makeFilter(cfg.deny)

  const all = await listFiles(repo.path)
  const tracked = all.filter((f) => filter(f.path))
  const known = opts.full ? new Map<string, string>() : await knownFiles(row.id)

  // Удалённые файлы: есть в БД, но пропали из рабочего дерева.
  // Пути с префиксом @deleted/ — это индекс истории (§21), их в рабочем дереве
  // нет по определению, и стирать их полным проходом было бы саботажем.
  const present = new Set(tracked.map((f) => f.path))
  const removed = [...known.keys()].filter((p) => !present.has(p) && !p.startsWith(DELETED_PREFIX))
  for (const path of removed) await deleteFile(row.id, path)

  const changed = tracked.filter((f) => known.get(f.path) !== f.blobSha)

  const report = emptyReport()
  report.scanned = tracked.length
  report.changed = changed.length
  report.deleted = removed.length

  let done = 0
  for (const f of changed) {
    done++
    opts.onProgress?.(done, changed.length, f.path)
    await processFile(repo, row.id, f.path, f.blobSha, modelId, embedder, report)
  }

  await markIndexed(row.id, await headCommit(repo.path))

  report.truncationRate = embedder.truncationRate()
  report.ms = Date.now() - started
  return report
}

/**
 * Точечная переиндексация набора путей — то, чем живёт watch-режим.
 *
 * Отличие от indexRepo не в объёме, а в источнике истины о содержимом: здесь
 * blob sha считается по рабочему файлу (`git hash-object`), а не берётся из
 * индекса git. Файл только что сохранён в редакторе, в индексе git его новой
 * версии ещё нет, и `git ls-files -s` вернул бы прежний sha — то есть правка
 * молча не попала бы в поиск.
 */
export async function indexPaths(
  repo: RepoConfig,
  paths: string[],
  opts: { modelId?: string; embedder?: Embedder } = {},
): Promise<IndexReport> {
  const started = Date.now()
  const cfg = loadConfig()
  const report = emptyReport()
  if (!paths.length) return report

  const embedder = opts.embedder ?? new Embedder()
  const modelId = opts.modelId ?? (await embedder.model())
  const row = await upsertRepo(repo.name, repo.path)

  const filter = makeFilter(cfg.deny)
  const candidates = paths.filter((p) => filter(p))
  report.scanned = candidates.length

  const known = await knownFiles(row.id)
  const shas = await hashWorkingFiles(repo.path, candidates)

  for (const path of candidates) {
    const blobSha = shas.get(path)

    // Пропал из рабочего дерева — убираем и его локации.
    if (!blobSha) {
      if (known.has(path)) {
        await deleteFile(row.id, path)
        report.deleted++
      }
      continue
    }
    if (known.get(path) === blobSha) continue

    report.changed++
    await processFile(repo, row.id, path, blobSha, modelId, embedder, report)
  }

  report.truncationRate = embedder.truncationRate()
  report.ms = Date.now() - started
  return report
}

/** Чтение, чанкинг, эмбеддинг недостающего и запись — общий путь обоих режимов. */
async function processFile(
  repo: RepoConfig,
  repoId: number,
  path: string,
  blobSha: string,
  modelId: string,
  embedder: Embedder,
  report: IndexReport,
): Promise<void> {
  const cfg = loadConfig()
  const abs = join(repo.path, path)

  let text: string
  let bytes: number
  try {
    bytes = (await stat(abs)).size
    if (bytes > 1024 * 1024) {
      report.skipped++
      return
    }
    text = await readFile(abs, 'utf8')
  } catch {
    report.skipped++
    return
  }

  const check = looksIndexable(text, bytes, path)
  if (!check.ok) {
    report.skipped++
    return
  }

  const file = chunkFile(repo.name, path, text, blobSha, cfg.chunk)
  if (!file.chunks.length) {
    report.skipped++
    return
  }
  report.chunks += file.chunks.length

  const prepared = prepare(file, modelId)
  const missing = await missingHashes(prepared.map((c) => c.hash))

  // Считаем вектор только для того, чего ещё нет ни в одном файле ни одной ветки.
  const toEmbed = prepared.filter((c) => missing.has(c.hash.toString('hex')))
  report.embedded += toEmbed.length
  report.reused += prepared.length - toEmbed.length

  const vectors = new Map<string, number[]>()
  if (toEmbed.length) {
    const vecs = await embedder.embed(
      toEmbed.map((c) => c.embedText),
      'document',
    )
    toEmbed.forEach((c, i) => vectors.set(c.hash.toString('hex'), vecs[i]!))
  }

  await commitFile(repoId, file, prepared, vectors, modelId)
}
