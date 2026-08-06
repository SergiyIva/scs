import { estimateTokens } from '../util/tokens.js'

/**
 * Вёрстка обзора репозитория под токен-бюджет.
 *
 * До этого repo_map выгружал ВСЕ каталоги со всеми экспортами. На нашем корпусе
 * это выглядело безобидно, на целевой монорепе (6763 файла) — разносит контекст
 * агента одним вызовом. Приём взят у Aider: карта репозитория обязана иметь
 * бюджет, иначе она не помогает ориентироваться, а мешает работать.
 *
 * Что именно урезаем и почему: сначала число символов на каталог (список из
 * сорока имён всё равно не читается), и только потом сами каталоги — по
 * возрастанию числа файлов, потому что каталог из двух файлов почти никогда
 * не является тем, ради чего звали обзор. Об усечении сообщаем явно: молчаливо
 * обрезанный обзор читается как «в проекте больше ничего нет».
 */

export interface DirRow {
  dir: string
  files: number
  symbols: string[]
}

/** Примерная цена символа в списке — имя плюс разделитель. */
const TOKENS_PER_SYMBOL = 4
const MIN_SYMBOLS = 3
const MAX_SYMBOLS = 25

export function renderRepoMap(rows: DirRow[], tokenBudget: number): string {
  if (!rows.length) return 'Индекс пуст или репозиторий не найден.'

  const totalFiles = rows.reduce((n, r) => n + r.files, 0)
  const header = `${rows.length} каталогов, ${totalFiles} файлов`

  // Чем больше каталогов, тем короче список символов у каждого: обзор из ста
  // строк по двадцать пять имён нечитаем независимо от бюджета.
  const cap = clamp(Math.round(tokenBudget / rows.length / TOKENS_PER_SYMBOL), MIN_SYMBOLS, MAX_SYMBOLS)

  const byWeight = [...rows].sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))

  const kept: { dir: string; block: string }[] = []
  let spent = estimateTokens(header)
  let omittedDirs = 0
  let omittedFiles = 0

  for (const r of byWeight) {
    const block = renderDir(r, cap)
    const cost = estimateTokens(block)
    // Первый каталог показываем всегда: пустой обзор бесполезнее переполненного.
    if (kept.length > 0 && spent + cost > tokenBudget) {
      omittedDirs++
      omittedFiles += r.files
      continue
    }
    kept.push({ dir: r.dir, block })
    spent += cost
  }

  // Выводим по алфавиту, а не по весу: обзор читают как дерево.
  kept.sort((a, b) => a.dir.localeCompare(b.dir))

  const out = [`${header}${omittedDirs ? ` (показано ${kept.length})` : ''}`, '', ...kept.map((k) => k.block)]

  if (omittedDirs) {
    out.push(
      `… ещё ${omittedDirs} каталогов (${omittedFiles} файлов) не показано: бюджет обзора исчерпан. ` +
        `Сузьте область параметром path_prefix или уменьшите depth.`,
    )
  }
  return out.join('\n')
}

function renderDir(r: DirRow, cap: number): string {
  const shown = r.symbols.slice(0, cap)
  const rest = r.symbols.length - shown.length
  const symbols = shown.length ? `${shown.join(', ')}${rest > 0 ? ` (+${rest})` : ''}` : '—'
  // Файл в корне репозитория группируется сам в себя, и «README.md/» выглядит
  // как несуществующий каталог — для агента это ложный след.
  const name = /\.[a-z]+$/i.test(r.dir) ? r.dir : `${r.dir}/`
  return `${name}  (${r.files} файлов)\n  экспорт: ${symbols}`
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}
