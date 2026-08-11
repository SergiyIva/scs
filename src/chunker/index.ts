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
  callers?: Map<string, string[]>,
): FileChunks {
  if (isMarkdown(path)) return chunkMarkdown(repo, path, text, blobSha, budget)
  return chunkCode(repo, path, text, blobSha, budget, callers)
}

function chunkCode(
  repo: string,
  path: string,
  text: string,
  blobSha: string,
  budget: ChunkBudget,
  callers?: Map<string, string[]>,
): FileChunks {
  const lang = langFor(path)
  const { imports, exports, candidates, sourceFile, moduleDoc } = parseFile(
    path,
    text,
    budget.maxTokens,
    budget.minTokens,
  )

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

  // 2. Всё, что не покрыто ни одним кандидатом: шапка файла, код между
  //    объявлениями, хвост после последнего.
  for (const [i, gap] of uncoveredSpans(text, candidates).entries()) {
    // Не обрезаем: длинный промежуток разрежет splitToFit по контексту модели.
    // Обрезка здесь означала бы, что часть кода не попала в индекс и её нельзя
    // найти ничем, при этом никто об этом не узнает.
    pieces.push({
      text: gap.text,
      startLine: lineOf(gap.start),
      endLine: lineOf(gap.end - 1),
      symbol: null,
      // Первый непокрытый кусок — это шапка файла, даже если начинается
      // не с нулевого смещения: обрезка ведущих пробелов сдвигает start,
      // и сравнение с нулём молча переводило шапку в 'binding'.
      kind: i === 0 && gap.isHead ? 'preamble' : 'binding',
      parentChain: [],
      exported: false,
      doc: null,
    })
  }

  // Куски обязаны идти в порядке файла: mergeSmall склеивает только соседей,
  // а промежутки добавлены последними, хотя физически стоят между кандидатами.
  pieces.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)

  // 3. Слияние мелочи: двадцать однострочных экспортов из index.ts должны стать
  //    одним чанком, а не двадцатью бесполезными векторами.
  const merged = mergeSmall(pieces, budget)

  // 4. Карточка файла: отвечает на «какие модули вообще про платежи», на что
  //    отдельная функция ответить не может.
  const card = fileCard(path, exports, imports, text, sourceFile.statements.length)

  const all: Piece[] = card ? [card, ...merged] : merged

  return {
    path,
    lang,
    blobSha,
    chunks: assemble({ repo, path, exports, imports, moduleDoc, callers }, all, budget),
  }
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
    parentDoc: c.parentDoc ?? null,
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
    parentDoc: c.parentDoc ?? null,
  }))
}

/**
 * Всё, что не попало ни в одного кандидата AST.
 *
 * История этого места стоит комментария. Сначала здесь склеивались ВСЕ
 * промежутки подряд, а номера строк брались от первого — диапазон получался
 * заведомо ложным. Тогда это «починили», оставив только шапку файла, с доводом
 * «промежутки между объявлениями смысла не несут». Довод оказался неверным:
 * замер на целевой монорепе нашёл 6504 верхнеуровневых объявления вида
 * `const X = new Schema(...)` и 2174 файла с `module.exports = {...}` — всё это
 * молча не попадало в индекс. Найти такой код было нельзя ничем, и никакой
 * ошибки при этом не возникало.
 *
 * Теперь покрываются все промежутки, но каждый — со своими настоящими границами.
 * Мелкие (короче minTokens) приклеиваются к предыдущему куску, а не заводят
 * отдельный бессмысленный вектор: они физически соседи, поэтому диапазон строк
 * остаётся честным.
 */
function uncoveredSpans(
  text: string,
  candidates: Candidate[],
): { text: string; start: number; end: number; isHead: boolean }[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start)
  const spans: { start: number; end: number }[] = []

  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor) spans.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < text.length) spans.push({ start: cursor, end: text.length })

  const out: { text: string; start: number; end: number; isHead: boolean }[] = []
  for (const s of spans) {
    const raw = text.slice(s.start, s.end)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const lead = raw.length - raw.trimStart().length
    out.push({
      text: trimmed,
      start: s.start + lead,
      end: s.start + lead + trimmed.length,
      isHead: s.start === 0,
    })
  }
  return out
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
    // Безымянный промежуток короче minTokens приклеивается к предыдущему куску
    // независимо от его размера: отдельный вектор на `const A = 1` между двумя
    // функциями — шум, а выбросить его нельзя, это потеря кода. Цепочки такое
    // слияние не образует, потому что именованный кусок так не поглощается.
    const isSmallGap =
      p.symbol === null &&
      (p.kind === 'binding' || p.kind === 'preamble') &&
      estimateTokens(p.text) < budget.minTokens

    const canMerge =
      prev &&
      (estimateTokens(prev.text) < budget.minTokens || isSmallGap) &&
      estimateTokens(prev.text) + estimateTokens(p.text) <=
        (isSmallGap ? budget.maxTokens : budget.targetTokens) &&
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
      // Если поглощающий кусок безымянный (шапка, промежуток), а поглощаемый —
      // объявление, то вид берём у объявления: чанк с функцией внутри не должен
      // называться preamble ни в выдаче, ни в приоритетах ранжирования.
      if (!prev.symbol && p.symbol) prev.kind = p.kind
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
