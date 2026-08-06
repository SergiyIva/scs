import type { FileChunks } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { parseFile, langFor, type Candidate } from './typescript.js'
import { assemble, type Piece } from './pieces.js'
import { chunkMarkdown, isMarkdown } from './markdown.js'
import type { ChunkBudget } from './budget.js'

export type { ChunkBudget }

/**
 * Точка входа чанкера: выбирает языковой разборщик по расширению.
 *
 * Markdown вынесен отдельно не из аккуратности, а потому что режется по другой
 * оси: у прозы нет AST, зато есть иерархия заголовков, и она несёт ровно тот же
 * смысл, что цепочка родителей у метода класса.
 */
export function chunkFile(
  repo: string,
  path: string,
  text: string,
  blobSha: string,
  budget: ChunkBudget,
): FileChunks {
  if (isMarkdown(path)) return chunkMarkdown(repo, path, text, blobSha, budget)
  return chunkCode(repo, path, text, blobSha, budget)
}

function chunkCode(
  repo: string,
  path: string,
  text: string,
  blobSha: string,
  budget: ChunkBudget,
): FileChunks {
  const lang = langFor(path)
  const { imports, exports, candidates, sourceFile } = parseFile(path, text, budget.maxTokens)

  const lineOf = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1

  const pieces: Piece[] = []

  // 1. Кандидаты из AST, с разрезанием переростков.
  for (const c of candidates) {
    const body = text.slice(c.start, c.end)
    const tokens = estimateTokens(body)

    if (tokens <= budget.maxTokens) {
      pieces.push(toPiece(c, body, lineOf))
      continue
    }
    for (const part of splitOversized(c, body, budget, lineOf)) pieces.push(part)
  }

  // 2. Шапка файла: импорты, константы и side-effect код до первого объявления.
  const preamble = preambleText(text, candidates, lineOf)
  if (preamble && estimateTokens(preamble.text) >= budget.minTokens) {
    pieces.push({
      // Не обрезаем: длинную шапку разрежет splitToFit по контексту модели.
      // Обрезка здесь означала бы, что часть кода не попала в индекс и её
      // нельзя найти ничем, при этом никто об этом не узнает.
      text: preamble.text,
      startLine: preamble.startLine,
      endLine: preamble.endLine,
      symbol: null,
      kind: 'preamble',
      parentChain: [],
      exported: false,
      doc: null,
    })
  }

  // Куски обязаны идти в порядке файла: mergeSmall склеивает только соседей,
  // а preamble добавлен последним, хотя физически стоит первым.
  pieces.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)

  // 3. Слияние мелочи: двадцать однострочных экспортов из index.ts должны стать
  //    одним чанком, а не двадцатью бесполезными векторами.
  const merged = mergeSmall(pieces, budget)

  // 4. Карточка файла: отвечает на «какие модули вообще про платежи», на что
  //    отдельная функция ответить не может.
  const card = fileCard(path, exports, imports, text, sourceFile.statements.length)

  const all: Piece[] = card ? [card, ...merged] : merged

  return { path, lang, blobSha, chunks: assemble({ repo, path, exports, imports }, all, budget) }
}

function toPiece(c: Candidate, body: string, lineOf: (o: number) => number): Piece {
  return {
    text: body,
    startLine: lineOf(c.start),
    endLine: lineOf(c.end),
    symbol: c.symbol,
    kind: c.kind,
    parentChain: c.parentChain,
    exported: c.exported,
    doc: c.doc,
  }
}

/**
 * Функция на 800 строк не должна давать один бессмысленный вектор.
 * Режем по строкам на части ~targetTokens, каждой части даём пометку (part k/n),
 * чтобы модель понимала, что это фрагмент, а не самостоятельная единица.
 */
function splitOversized(
  c: Candidate,
  body: string,
  budget: ChunkBudget,
  lineOf: (o: number) => number,
): Piece[] {
  const lines = body.split('\n')
  const startLine = lineOf(c.start)
  const parts: { lines: string[]; from: number }[] = []

  let current: string[] = []
  let from = 0
  let tokens = 0

  for (const [i, line] of lines.entries()) {
    const t = estimateTokens(line)
    if (tokens + t > budget.targetTokens && current.length > 0) {
      parts.push({ lines: current, from })
      current = []
      from = i
      tokens = 0
    }
    current.push(line)
    tokens += t
  }
  if (current.length) parts.push({ lines: current, from })

  const signature = lines[0]?.trim().slice(0, 200) ?? ''

  return parts.map((p, i) => ({
    text:
      i === 0
        ? p.lines.join('\n')
        : `${signature}\n// ... фрагмент ${i + 1}/${parts.length}\n${p.lines.join('\n')}`,
    startLine: startLine + p.from,
    endLine: startLine + p.from + p.lines.length - 1,
    symbol: c.symbol,
    kind: c.kind,
    parentChain: c.parentChain,
    exported: c.exported,
    doc: c.doc,
  }))
}

/**
 * Шапка файла — всё до первого объявления: импорты, константы, side-effect код.
 *
 * Раньше здесь склеивались ВСЕ непокрытые промежутки (включая пустые строки между
 * функциями), а номера строк возвращались от первого из них. Диапазон получался
 * заведомо ложным. Промежутки между объявлениями смысла всё равно не несут,
 * поэтому берём только непрерывный кусок в начале файла и его настоящие границы.
 */
function preambleText(
  text: string,
  candidates: Candidate[],
  lineOf: (o: number) => number,
): { text: string; startLine: number; endLine: number } | null {
  const firstStart = candidates.length
    ? Math.min(...candidates.map((c) => c.start))
    : text.length

  const head = text.slice(0, firstStart).trim()
  if (!head) return null

  return {
    text: head,
    startLine: 1,
    endLine: Math.max(1, lineOf(firstStart) - 1),
  }
}

/** Жадно склеивает соседей ниже minTokens, пока не дойдёт до targetTokens. */
function mergeSmall(pieces: Piece[], budget: ChunkBudget): Piece[] {
  const out: Piece[] = []

  for (const p of pieces) {
    const prev = out[out.length - 1]
    // Условие смотрит только на предыдущий кусок намеренно.
    //
    // Пробовали сливать, если мал любой из двух: слияние пошло цепочкой и
    // склеило preamble с двумя функциями подряд, потому что после каждого слияния
    // следующий мелкий сосед снова проходил проверку. Проблему мелких чанков
    // (заголовок весит больше кода) решает пропорциональный заголовок
    // в buildHeader, а не более жадное слияние: склейка ломает поиск по
    // отдельным символам, который сейчас работает.
    const canMerge =
      prev &&
      estimateTokens(prev.text) < budget.minTokens &&
      estimateTokens(prev.text) + estimateTokens(p.text) <= budget.targetTokens &&
      prev.kind !== 'file_card' &&
      p.kind !== 'file_card' &&
      // Не сливаем через границу класса: контексты разные.
      prev.parentChain.join('>') === p.parentChain.join('>') &&
      // Только физических соседей: склейка кусков из разных концов файла
      // даёт диапазон строк, не соответствующий ничему.
      p.startLine >= prev.startLine

    if (canMerge) {
      prev.text = `${prev.text}\n\n${p.text}`
      prev.endLine = Math.max(prev.endLine, p.endLine)
      prev.symbol = [prev.symbol, p.symbol].filter(Boolean).join(', ') || null
      prev.exported = prev.exported || p.exported
      prev.doc ??= p.doc
      continue
    }
    out.push({ ...p })
  }
  return out
}

/**
 * Карточка файла: путь, экспорты, импорты и верхний JSDoc без тел функций.
 * Отвечает на запросы уровня «какие модули вообще про платежи».
 */
function fileCard(
  path: string,
  exports: string[],
  imports: string[],
  text: string,
  stmtCount: number,
): Piece | null {
  if (!exports.length && !imports.length) return null

  // JSDoc модуля часто идёт после блока импортов, а не с первого символа файла,
  // поэтому ищем первый /** */ в начальном фрагменте, а не строго в позиции 0.
  const topDoc = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(0, 3000))
  const summary = topDoc?.[1]
    ?.split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')

  const body = [
    `Модуль ${path}`,
    summary ? `Описание: ${summary}` : null,
    exports.length ? `Экспортирует: ${exports.join(', ')}` : null,
    imports.length ? `Зависит от: ${imports.join(', ')}` : null,
    `Верхнеуровневых объявлений: ${stmtCount}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    text: body,
    startLine: 1,
    endLine: Math.min(text.split('\n').length, 1),
    symbol: null,
    kind: 'file_card',
    parentChain: [],
    exported: false,
    doc: summary ?? null,
  }
}
