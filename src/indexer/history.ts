import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoConfig } from '../config.js'
import { loadConfig } from '../config.js'
import { chunkFile } from '../chunker/index.js'
import { Embedder } from '../embed/client.js'
import { makeFilter, looksIndexable } from './deny.js'
import { upsertRepo } from '../store/repos.js'
import { commitFile, missingHashes, prepare } from '../store/chunks.js'

const exec = promisify(execFile)

/**
 * Индексация удалённого кода из истории git.
 *
 * Зачем: телеметрия роя (§16) показала, что 4.9% вызовов — это `git show` по
 * удалённым файлам, то есть вопрос «а где это было до рефакторинга». Индекс
 * рабочего дерева на него не отвечает принципиально: файла там уже нет.
 *
 * Почему отдельным режимом, а не всегда: история раздувает индекс, и раздувает
 * его самым неприятным образом — старыми версиями того же кода. Они похожи
 * на актуальные, поэтому конкурируют с ними в выдаче, ничего не добавляя.
 * Отсюда три ограничения: только УДАЛЁННЫЕ файлы (у существующих актуальная
 * версия уже в индексе), только последнее их содержимое, и ограничение
 * по глубине истории.
 *
 * Путь помечается префиксом `@deleted/`, чтобы в выдаче это нельзя было
 * перепутать с живым кодом.
 */

export const DELETED_PREFIX = '@deleted/'

export interface HistoryReport {
  candidates: number
  indexed: number
  skipped: number
  chunks: number
  embedded: number
  reused: number
  ms: number
}

export interface HistoryOptions {
  /** Сколько коммитов истории просматривать. */
  depth?: number
  onProgress?: (done: number, total: number, path: string) => void
}

/** Файлы, удалённые за последние `depth` коммитов, и коммит, где они ещё были. */
async function deletedFiles(root: string, depth: number): Promise<Map<string, string>> {
  const { stdout } = await exec(
    'git',
    ['log', `-n${depth}`, '--diff-filter=D', '--name-only', '--pretty=format:%H', '-z'],
    { cwd: root, maxBuffer: 128 * 1024 * 1024 },
  )

  const out = new Map<string, string>()
  let commit = ''
  for (const token of stdout.split('\0')) {
    if (!token) continue
    // Заголовок коммита приходит вместе с первым путём, разделённые \n.
    const nl = token.indexOf('\n')
    if (/^[0-9a-f]{40}/.test(token)) {
      commit = token.slice(0, 40)
      if (nl >= 0) {
        const path = token.slice(nl + 1)
        // Содержимое берём из РОДИТЕЛЯ коммита удаления — там файл ещё жив.
        if (path && !out.has(path)) out.set(path, `${commit}^`)
      }
      continue
    }
    if (commit && !out.has(token)) out.set(token, `${commit}^`)
  }
  return out
}

async function showFile(root: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['show', `${ref}:${path}`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch {
    // Файл мог быть добавлен и удалён внутри одного диапазона, либо родителя нет.
    return null
  }
}

export async function indexHistory(
  repo: RepoConfig,
  opts: HistoryOptions = {},
): Promise<HistoryReport> {
  const started = Date.now()
  const cfg = loadConfig()
  const depth = opts.depth ?? 500

  const embedder = new Embedder()
  const modelId = await embedder.model()
  const row = await upsertRepo(repo.name, repo.path)
  const filter = makeFilter(cfg.deny)

  const deleted = await deletedFiles(repo.path, depth)
  const report: HistoryReport = {
    candidates: 0,
    indexed: 0,
    skipped: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    ms: 0,
  }

  const targets = [...deleted].filter(([path]) => filter(path))
  report.candidates = targets.length

  let done = 0
  for (const [path, ref] of targets) {
    done++
    opts.onProgress?.(done, targets.length, path)

    const text = await showFile(repo.path, ref, path)
    if (text === null) {
      report.skipped++
      continue
    }
    const check = looksIndexable(text, Buffer.byteLength(text), path)
    if (!check.ok) {
      report.skipped++
      continue
    }

    const virtualPath = `${DELETED_PREFIX}${path}`
    const file = chunkFile(repo.name, virtualPath, text, `deleted:${ref}`, cfg.chunk)
    if (!file.chunks.length) {
      report.skipped++
      continue
    }

    report.chunks += file.chunks.length
    const prepared = prepare(file, modelId)
    const missing = await missingHashes(prepared.map((c) => c.hash))
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
    report.indexed++
  }

  report.ms = Date.now() - started
  return report
}
