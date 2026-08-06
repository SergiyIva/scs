import type { RawChunk, ChunkKind } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { buildHeader } from './enrich.js'
import type { ChunkBudget } from './budget.js'

/**
 * Общая часть всех чанкеров: кусок текста с координатами и сборка чанка из него.
 *
 * Языковой чанкер (TS через компилятор, Markdown через заголовки) отвечает только
 * за то, ГДЕ резать. Что дальше — обогащающий заголовок, страховка по контексту
 * модели, подсчёт токенов — одинаково для всех и живёт здесь.
 */

export interface Piece {
  text: string
  startLine: number
  endLine: number
  symbol: string | null
  kind: ChunkKind
  parentChain: string[]
  exported: boolean
  doc: string | null
}

/** Потолок модели EmbeddingGemma. Заголовок + текст обязаны влезть сюда целиком. */
export const MODEL_CONTEXT = 2048

export interface AssembleContext {
  repo: string
  path: string
  /** Экспортируемые символы файла (для Markdown — заголовки документа). */
  exports: string[]
  /** Импортируемые модули (для Markdown — ссылки на соседние документы). */
  imports: string[]
}

/** Заголовок обогащения + страховка по контексту модели → готовые чанки. */
export function assemble(ctx: AssembleContext, pieces: Piece[], budget: ChunkBudget): RawChunk[] {
  return pieces.flatMap((p) => {
    const header = buildHeader(
      {
        repo: ctx.repo,
        path: ctx.path,
        exports: ctx.exports,
        imports: ctx.imports,
        parentChain: p.parentChain,
        symbol: p.symbol,
        kind: p.kind,
        doc: p.doc,
      },
      budget.headerBudget,
      estimateTokens(p.text),
    )
    const bodyBudget = MODEL_CONTEXT - estimateTokens(header) - 8

    // Раньше здесь стоял truncateToTokens: хвост чанка молча пропадал из индекса,
    // и найти его было нельзя вообще ничем. Теперь переросток разрезается на
    // несколько чанков — каждый со своим вектором и своими номерами строк.
    return splitToFit(p, bodyBudget).map((part) => {
      const embedText = `${header}\n${part.text}`
      return {
        embedText,
        rawText: part.text,
        startLine: part.startLine,
        endLine: part.endLine,
        symbol: p.symbol,
        kind: p.kind,
        parentChain: p.parentChain,
        exported: p.exported,
        tokenCount: estimateTokens(embedText),
      }
    })
  })
}

/**
 * Последняя страховка перед моделью: разрезает кусок, не влезающий в контекст.
 *
 * Штатно так быть не должно — maxTokens (700) сильно ниже контекста модели (2048),
 * и языковой чанкер режет ещё раньше. Сюда попадают только патологии: гигантская
 * карточка файла, слитая шапка, огромный заголовок обогащения. Но молча терять
 * хвост нельзя: текст, не попавший в индекс, невозможно найти ни семантикой,
 * ни лексикой, и об этом никто не узнает.
 */
export function splitToFit(p: Piece, bodyBudget: number): Piece[] {
  if (estimateTokens(p.text) <= bodyBudget) return [p]

  const lines = p.text.split('\n')
  const parts: Piece[] = []
  let current: string[] = []
  let tokens = 0
  let lineOffset = 0

  const flush = () => {
    if (!current.length) return
    parts.push({
      ...p,
      text: current.join('\n'),
      startLine: p.startLine + lineOffset,
      endLine: Math.min(p.endLine, p.startLine + lineOffset + current.length - 1),
    })
    lineOffset += current.length
    current = []
    tokens = 0
  }

  for (const line of lines) {
    const t = estimateTokens(line)
    if (tokens + t > bodyBudget && current.length) flush()
    current.push(line)
    tokens += t
  }
  flush()

  return parts.length ? parts : [p]
}
