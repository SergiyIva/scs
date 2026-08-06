import ts from 'typescript'
import type { ChunkKind } from '../types.js'

/**
 * Разбор TS/JS через TypeScript Compiler API.
 *
 * Отклонение от исходного плана (там был tree-sitter) и почему: ts.createSourceFile —
 * чистый JS без нативной сборки, что важно, потому что целевая машина другая
 * (AMD, возможно Windows), а tree-sitter требует node-gyp. Плюс компилятор
 * из коробки отдаёт JSDoc и модификаторы экспорта, которых у tree-sitter нет.
 * Здесь используется ТОЛЬКО парсер, без Program и без чекера — типы не
 * резолвятся, поэтому разбор быстрый и не зависит от tsconfig проекта.
 */

export interface Candidate {
  symbol: string | null
  kind: ChunkKind
  parentChain: string[]
  exported: boolean
  doc: string | null
  /** Смещение начала с учётом ведущего JSDoc. */
  start: number
  end: number
}

export interface ParsedFile {
  imports: string[]
  exports: string[]
  candidates: Candidate[]
  sourceFile: ts.SourceFile
}

export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.mts') || path.endsWith('.cts') || path.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

export function langFor(path: string): string {
  const m = /\.([a-z]+)$/i.exec(path)
  const ext = m?.[1]?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'jsx':
      return 'jsx'
    default:
      return 'javascript'
  }
}

/** Первая содержательная строка JSDoc — самый дешёвый источник человеческой семантики. */
function extractDoc(node: ts.Node, text: string): { doc: string | null; start: number } {
  const nodeStart = node.getStart(node.getSourceFile(), false)
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const jsdoc = [...ranges].reverse().find((r) => text.slice(r.pos, r.pos + 3) === '/**')
  if (!jsdoc) return { doc: null, start: nodeStart }

  const body = text.slice(jsdoc.pos, jsdoc.end)
  const first = body
    .split('\n')
    .map((l) => l.replace(/^\s*\/?\*+\/?/, '').trim())
    .find((l) => l.length > 0 && !l.startsWith('@'))

  return { doc: first ? first.slice(0, 200) : null, start: jsdoc.pos }
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}

function nameOf(node: ts.Node): string | null {
  const named = node as { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name)) return named.name.text
  if (named.name && ts.isStringLiteral(named.name)) return named.name.text
  return null
}

/** PascalCase-функция в TSX почти всегда React-компонент. Помечаем — это заметно помогает
 *  запросам вида «где рисуется форма оплаты». */
function isComponent(symbol: string | null, kind: ts.ScriptKind): boolean {
  if (!symbol) return false
  const jsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
  return jsx && /^[A-Z]/.test(symbol)
}

export function parseFile(path: string, text: string, maxTokensPerNode: number): ParsedFile {
  const kind = scriptKindFor(path)
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)

  const imports: string[] = []
  const exports: string[] = []
  const candidates: Candidate[] = []

  const push = (node: ts.Node, symbol: string | null, chunkKind: ChunkKind, parents: string[]) => {
    const { doc, start } = extractDoc(node, text)
    candidates.push({
      symbol,
      kind: chunkKind,
      parentChain: parents,
      exported: isExported(node),
      doc,
      start,
      end: node.getEnd(),
    })
  }

  const approxTokens = (node: ts.Node) => Math.ceil((node.getEnd() - node.getStart(sourceFile)) / 3.2)

  for (const stmt of sourceFile.statements) {
    // Импорты и реэкспорты — в заголовок обогащения, отдельными чанками не идут.
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      imports.push(stmt.moduleSpecifier.text)
      continue
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        imports.push(stmt.moduleSpecifier.text)
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) exports.push(el.name.text)
      }
      continue
    }

    if (ts.isFunctionDeclaration(stmt)) {
      const symbol = nameOf(stmt)
      if (isExported(stmt) && symbol) exports.push(symbol)
      push(stmt, symbol, isComponent(symbol, kind) ? 'component' : 'function', [])
      continue
    }

    if (ts.isClassDeclaration(stmt)) {
      const symbol = nameOf(stmt)
      if (isExported(stmt) && symbol) exports.push(symbol)

      // Класс целиком, если влезает. Иначе — по методам: один вектор на класс
      // в тысячу строк бессмыслен.
      if (approxTokens(stmt) <= maxTokensPerNode) {
        push(stmt, symbol, 'class', [])
      } else {
        for (const member of stmt.members) {
          if (
            ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ) {
            const mName = ts.isConstructorDeclaration(member) ? 'constructor' : nameOf(member)
            push(member, mName, 'method', symbol ? [symbol] : [])
          }
        }
      }
      continue
    }

    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      const symbol = nameOf(stmt)
      if (isExported(stmt) && symbol) exports.push(symbol)
      push(stmt, symbol, 'type', [])
      continue
    }

    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations
      const fnDecls = decls.filter(
        (d) =>
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer) ||
            ts.isClassExpression(d.initializer)),
      )
      if (fnDecls.length === 0) continue // константы уходят в preamble

      for (const d of fnDecls) {
        const symbol = ts.isIdentifier(d.name) ? d.name.text : null
        if (isExported(stmt) && symbol) exports.push(symbol)
        const chunkKind: ChunkKind =
          d.initializer && ts.isClassExpression(d.initializer)
            ? 'class'
            : isComponent(symbol, kind)
              ? 'component'
              : 'function'
        // Берём весь VariableStatement, чтобы в чанк попали export и const.
        const { doc, start } = extractDoc(stmt, text)
        candidates.push({
          symbol,
          kind: chunkKind,
          parentChain: [],
          exported: isExported(stmt),
          doc,
          start: fnDecls.length === 1 ? start : d.getStart(sourceFile),
          end: fnDecls.length === 1 ? stmt.getEnd() : d.getEnd(),
        })
      }
      continue
    }

    if (ts.isExportAssignment(stmt)) {
      exports.push('default')
    }
  }

  candidates.sort((a, b) => a.start - b.start)
  return { imports: dedupe(imports), exports: dedupe(exports), candidates, sourceFile }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}
