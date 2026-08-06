import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig } from '../config.js'
import { loadConfig } from '../config.js'
import { chunkFile } from '../chunker/index.js'
import { Embedder } from '../embed/client.js'
import { listFiles, headCommit, isGitRepo } from './git.js'
import { makeFilter, looksIndexable } from './deny.js'
import { upsertRepo, markIndexed } from '../store/repos.js'
import { commitFile, deleteFile, knownFiles, missingHashes, prepare } from '../store/chunks.js'

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
  const present = new Set(tracked.map((f) => f.path))
  const removed = [...known.keys()].filter((p) => !present.has(p))
  for (const path of removed) await deleteFile(row.id, path)

  const changed = tracked.filter((f) => known.get(f.path) !== f.blobSha)

  const report: IndexReport = {
    scanned: tracked.length,
    changed: changed.length,
    deleted: removed.length,
    skipped: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    truncationRate: 0,
    ms: 0,
  }

  let done = 0
  for (const f of changed) {
    done++
    opts.onProgress?.(done, changed.length, f.path)

    const abs = join(repo.path, f.path)
    let text: string
    let bytes: number
    try {
      bytes = (await stat(abs)).size
      if (bytes > 1024 * 1024) {
        report.skipped++
        continue
      }
      text = await readFile(abs, 'utf8')
    } catch {
      report.skipped++
      continue
    }

    const check = looksIndexable(text, bytes, f.path)
    if (!check.ok) {
      report.skipped++
      continue
    }

    const file = chunkFile(repo.name, f.path, text, f.blobSha, cfg.chunk)
    if (!file.chunks.length) {
      report.skipped++
      continue
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

    await commitFile(row.id, file, prepared, vectors, modelId)
  }

  await markIndexed(row.id, await headCommit(repo.path))

  report.truncationRate = embedder.truncationRate()
  report.ms = Date.now() - started
  return report
}
