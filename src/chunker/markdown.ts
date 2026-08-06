import type { FileChunks } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { assemble, type Piece } from './pieces.js'
import type { ChunkBudget } from './budget.js'

/**
 * Чанкер Markdown/MDX по заголовкам.
 *
 * Зачем вообще: в целевой монорепе 471 md-файл, и документация написана
 * естественным языком — ровно тем, которым формулируются запросы. Это самый
 * дешёвый источник семантики во всём корпусе, дороже любого кода.
 *
 * Ось резки другая, чем у кода: AST нет, зато есть иерархия заголовков, и она
 * играет роль цепочки родителей. Секция — это заголовок плюс текст до СЛЕДУЮЩЕГО
 * заголовка любого уровня: иначе текст родителя дублировался бы в каждом потомке,
 * а вектор дубля конкурирует с оригиналом за место в выдаче.
 */

export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

export function langFor(path: string): string {
  return /\.mdx$/i.test(path) ? 'mdx' : 'markdown'
}

interface Section {
  level: number
  title: string
  chain: string[]
  /** Строка самого заголовка, 1-based. */
  startLine: number
  /** Последняя строка тела секции, 1-based. */
  endLine: number
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/
const FENCE = /^ {0,3}(```|~~~)/

export function chunkMarkdown(
  repo: string,
  path: string,
  text: string,
  blobSha: string,
  budget: ChunkBudget,
): FileChunks {
  const lines = text.split('\n')
  const front = frontmatter(lines)
  const sections = parseSections(lines)

  const docTitle = front.title ?? sections.find((s) => s.level === 1)?.title ?? null
  const headings = sections.map((s) => s.title)
  const links = relativeLinks(text)

  const pieces: Piece[] = []

  // Вступление до первого заголовка. Frontmatter оставляем внутри: title
  // и description оттуда — это описание документа человеческими словами.
  const introEnd = (sections[0]?.startLine ?? lines.length + 1) - 1
  const intro = lines.slice(0, introEnd).join('\n').trim()
  if (intro && estimateTokens(intro) >= budget.minTokens) {
    pieces.push({
      text: intro,
      startLine: 1,
      endLine: Math.max(1, introEnd),
      symbol: docTitle,
      kind: 'preamble',
      parentChain: [],
      exported: false,
      doc: front.description ?? null,
    })
  }

  for (const s of sections) {
    const body = lines.slice(s.startLine - 1, s.endLine).join('\n').trimEnd()
    if (!body.trim()) continue

    const piece: Piece = {
      text: body,
      startLine: s.startLine,
      endLine: s.endLine,
      symbol: s.title,
      kind: 'section',
      parentChain: s.chain,
      exported: false,
      doc: firstProseLine(lines.slice(s.startLine, s.endLine)),
    }

    if (estimateTokens(body) <= budget.maxTokens) {
      pieces.push(piece)
      continue
    }
    pieces.push(...splitLongSection(piece, budget))
  }

  const merged = mergeSmall(pieces, budget)
  const card = docCard(path, docTitle, front.description, headings, links, lines.length)

  return {
    path,
    lang: langFor(path),
    blobSha,
    chunks: assemble(
      { repo, path, exports: headings, imports: links },
      card ? [card, ...merged] : merged,
      budget,
    ),
  }
}

/**
 * Заголовки внутри блока кода — не заголовки: в документации по shell
 * комментарий `# установка зависимостей` встречается на каждой странице,
 * и без учёта ограждений документ разваливается на мусорные секции.
 */
function parseSections(lines: string[]): Section[] {
  const sections: Section[] = []
  const stack: { level: number; title: string }[] = []
  let fence: string | null = null
  let frontOpen = lines[0]?.trim() === '---'

  for (const [i, line] of lines.entries()) {
    if (frontOpen) {
      if (i > 0 && line.trim() === '---') frontOpen = false
      continue
    }

    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (line.trimStart().startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) continue

    const m = HEADING.exec(line)
    if (!m) continue

    const level = m[1]!.length
    const title = m[2]!.replace(/\s*#+\s*$/, '').trim()

    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop()

    const prev = sections[sections.length - 1]
    if (prev) prev.endLine = i // строка перед заголовком, 1-based → i

    sections.push({ level, title, chain: stack.map((s) => s.title), startLine: i + 1, endLine: lines.length })
    stack.push({ level, title })
  }

  return sections
}

interface Frontmatter {
  title: string | null
  description: string | null
}

/** YAML-frontmatter парсим ровно на две строки: title и description. Больше не нужно. */
function frontmatter(lines: string[]): Frontmatter {
  if (lines[0]?.trim() !== '---') return { title: null, description: null }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return { title: null, description: null }

  const field = (name: string) => {
    const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'i')
    const hit = lines.slice(1, end).map((l) => re.exec(l)?.[1]).find(Boolean)
    return hit ? hit.trim().replace(/^['"]|['"]$/g, '').slice(0, 200) : null
  }
  return { title: field('title'), description: field('description') }
}

/** Первая строка прозы — то же, чем для функции является первая строка JSDoc. */
function firstProseLine(body: string[]): string | null {
  let fence: string | null = null
  for (const line of body) {
    const f = FENCE.exec(line)
    if (f) {
      fence = fence === null ? f[1]! : null
      continue
    }
    if (fence !== null) continue

    const t = line.trim()
    if (!t || t.startsWith('|') || t.startsWith('<')) continue
    const clean = t.replace(/^[-*+>]\s+/, '').replace(/^\d+\.\s+/, '')
    if (clean.length > 1) return clean.slice(0, 200)
  }
  return null
}

/**
 * Длинная секция режется по абзацам, а не по строкам: разрыв посреди абзаца
 * даёт два куска, каждый из которых непонятен сам по себе. Каждая часть
 * получает заголовок секции — без него часть 2 повисает без темы.
 */
function splitLongSection(p: Piece, budget: ChunkBudget): Piece[] {
  const lines = p.text.split('\n')
  const parts: { lines: string[]; from: number }[] = []

  let current: string[] = []
  let from = 0
  let tokens = 0

  for (const [i, line] of lines.entries()) {
    const t = estimateTokens(line)
    const atBoundary = line.trim() === '' && current.length > 0
    if (tokens + t > budget.targetTokens && atBoundary) {
      parts.push({ lines: current, from })
      current = []
      from = i
      tokens = 0
    }
    current.push(line)
    tokens += t
  }
  if (current.length) parts.push({ lines: current, from })

  const heading = lines[0]?.trim() ?? ''

  return parts.map((part, i) => ({
    ...p,
    text:
      i === 0
        ? part.lines.join('\n')
        : `${heading}\n<!-- часть ${i + 1}/${parts.length} -->\n${part.lines.join('\n')}`,
    startLine: p.startLine + part.from,
    endLine: Math.min(p.endLine, p.startLine + part.from + part.lines.length - 1),
  }))
}

/**
 * Заголовок без текста («## Установка» и сразу «### Docker») сам по себе не несёт
 * ничего — склеиваем с последующим. Условие смотрит только на предыдущий кусок:
 * при более жадном слиянии цепочка съедает половину документа в один вектор.
 */
function mergeSmall(pieces: Piece[], budget: ChunkBudget): Piece[] {
  const out: Piece[] = []

  for (const p of pieces) {
    const prev = out[out.length - 1]
    const canMerge =
      prev &&
      estimateTokens(prev.text) < budget.minTokens &&
      estimateTokens(prev.text) + estimateTokens(p.text) <= budget.targetTokens &&
      p.startLine >= prev.startLine

    if (canMerge) {
      prev.text = `${prev.text}\n\n${p.text}`
      prev.endLine = Math.max(prev.endLine, p.endLine)
      prev.symbol = [prev.symbol, p.symbol].filter(Boolean).join(', ') || null
      prev.doc ??= p.doc
      continue
    }
    out.push({ ...p })
  }
  return out
}

/**
 * Карточка документа: оглавление без тела. Отвечает на запрос уровня «где вообще
 * описан деплой», на который отдельная секция ответить не может.
 */
function docCard(
  path: string,
  title: string | null,
  description: string | null,
  headings: string[],
  links: string[],
  lineCount: number,
): Piece | null {
  if (!headings.length && !title) return null

  const body = [
    `Документ ${path}`,
    title ? `Заголовок: ${title}` : null,
    description ? `Описание: ${description}` : null,
    headings.length ? `Разделы: ${headings.slice(0, 40).join(' · ')}` : null,
    links.length ? `Ссылается на: ${links.slice(0, 12).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    text: body,
    startLine: 1,
    endLine: Math.min(lineCount, 1),
    symbol: title,
    kind: 'file_card',
    parentChain: [],
    exported: false,
    doc: description ?? null,
  }
}

/** Ссылки на соседние документы — то же, чем для модуля являются импорты. */
function relativeLinks(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]!
    if (/^(https?:|mailto:|#)/i.test(href)) continue
    out.add(href.split('#')[0]!)
  }
  return [...out].filter(Boolean)
}
