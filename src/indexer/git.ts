import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const exec = promisify(execFile)

/**
 * `git hash-object --stdin-paths` читает список путей со stdin, поэтому execFile
 * здесь не годится: опция `input` существует только у синхронного execFileSync.
 */
function hashObjects(root: string, paths: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['hash-object', '--stdin-paths'], { cwd: root })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git hash-object: ${err.trim()}`)),
    )
    child.stdin.end(`${paths.join('\n')}\n`)
  })
}

export interface GitFile {
  path: string
  blobSha: string
}

/**
 * `git ls-files -s` отдаёт blob sha по каждому файлу НЕ ЧИТАЯ сами файлы.
 * Одна команда даёт полное состояние рабочего дерева, поэтому диф с тем, что
 * лежит в БД, считается за миллисекунды даже на монорепе. Это то, что превращает
 * переключение веток из катастрофы в рутинную операцию.
 *
 * Побочный эффект: индексируются только отслеживаемые файлы, то есть .gitignore
 * соблюдается автоматически и бесплатно.
 */
export async function listFiles(root: string): Promise<GitFile[]> {
  const { stdout } = await exec('git', ['ls-files', '-s', '-z'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  })

  const out: GitFile[] = []
  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    // формат: "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const meta = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    const blobSha = meta[1]
    if (blobSha) out.push({ path, blobSha })
  }

  out.push(...(await listUntracked(root)))
  return out
}

/**
 * Новые файлы, ещё не добавленные в индекс git.
 *
 * Без этого только что созданный файл невидим для поиска до первого `git add`,
 * а незакоммиченная работа — это ровно тот код, по которому ищут чаще всего.
 * --exclude-standard оставляет .gitignore в силе, поэтому мусор не попадает.
 *
 * Своего blob sha у таких файлов нет, поэтому считаем его сами: `git hash-object`
 * даёт ровно тот же sha, что появится после `git add`. Значит, при добавлении
 * файла в индекс его чанки не будут пересчитаны заново.
 */
async function listUntracked(root: string): Promise<GitFile[]> {
  const { stdout } = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
  const paths = stdout.split('\0').filter(Boolean)
  if (!paths.length) return []

  const shas = (await hashObjects(root, paths)).split('\n').filter(Boolean)
  return paths.flatMap((path, i) => {
    const blobSha = shas[i]
    return blobSha ? [{ path, blobSha }] : []
  })
}

/**
 * Blob sha по РАБОЧИМ файлам, а не по индексу git.
 *
 * Для watch-режима это принципиально: файл только что сохранён, в индексе git
 * его новой версии нет, и `git ls-files -s` вернул бы прежний sha. Хэш считается
 * тем же алгоритмом, что применит `git add`, поэтому последующее добавление
 * в индекс не вызовет пересчёта векторов.
 *
 * Пути, которых нет на диске, в результат не попадают — по их отсутствию
 * вызывающий код узнаёт об удалении.
 */
export async function hashWorkingFiles(
  root: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!paths.length) return out

  const existing: string[] = []
  for (const p of paths) {
    try {
      await stat(join(root, p))
      existing.push(p)
    } catch {
      // нет на диске — удалён
    }
  }
  if (!existing.length) return out

  const shas = (await hashObjects(root, existing)).split('\n').filter(Boolean)
  existing.forEach((p, i) => {
    const sha = shas[i]
    if (sha) out.set(p, sha)
  })
  return out
}

export async function headCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: root })
    return true
  } catch {
    return false
  }
}
