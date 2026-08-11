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
  /** JSDoc родителя (класса) для его методов: сам метод часто описан скупо. */
  parentDoc?: string | null
  /** Смещение начала с учётом ведущего JSDoc. */
  start: number
  end: number
}

export interface ParsedFile {
  imports: string[]
  exports: string[]
  candidates: Candidate[]
  sourceFile: ts.SourceFile
  /** Первая строка модульного JSDoc: назначение файла человеческими словами. */
  moduleDoc: string | null
}

/**
 * Настоящий модульный JSDoc — то есть блок, описывающий ФАЙЛ, а не первое
 * объявление в нём.
 *
 * Разница принципиальна, и первая версия этой функции её не делала: она брала
 * первый `/** ... *\/` в первых 3000 символах, поэтому у файла без модульного
 * комментария в заголовок ВСЕХ чанков уезжал JSDoc первой функции. Замер
 * с такой реализацией мерил не то, что заявлено, и вывод «окупился модульный
 * JSDoc» был сильнее данных.
 *
 * Блок считается модульным, если он стоит до первого объявления и выполнено
 * хотя бы одно условие:
 *   - в нём есть @module / @file / @fileoverview — явное заявление намерения;
 *   - между ним и следующим кодом пустая строка (конвенция JSDoc: блок,
 *     отделённый пустой строкой, не привязан к следующему объявлению);
 *   - следующая за ним конструкция — import или require, то есть привязываться
 *     ему всё равно не к чему.
 */
export function moduleDocRange(text: string): { pos: number; end: number } | null {
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? []
  const jsdoc = ranges.find((r) => text.slice(r.pos, r.pos + 3) === '/**')
  if (!jsdoc) return null

  const tail = text.slice(jsdoc.end)
  const tagged = /@(module|file|fileoverview)\b/.test(text.slice(jsdoc.pos, jsdoc.end))
  const blankLineAfter = /^[^\S\n]*\n[^\S\n]*\n/.test(tail)
  const importsNext = /^\s*(import\b|const\s.*=\s*require\()/.test(tail)
  return tagged || blankLineAfter || importsNext ? { pos: jsdoc.pos, end: jsdoc.end } : null
}

export function moduleDocOf(text: string): string | null {
  const jsdoc = moduleDocRange(text)
  if (!jsdoc) return null

  const lines = text
    .slice(jsdoc.pos, jsdoc.end)
    .split('\n')
    .map((l) => l.replace(/^\s*\/?\*+/, '').replace(/\*\/\s*$/, '').trim())
    .filter((l) => l.length > 0)

  // У `@fileoverview Роутер платежей.` содержательная часть стоит ПОСЛЕ тега:
  // отбросив строку целиком, мы потеряли бы ровно то, ради чего пришли.
  for (const l of lines) {
    const tagged = /^@(module|file|fileoverview)\s+(.+)$/.exec(l)
    if (tagged) return tagged[2]!.slice(0, 200)
    if (!l.startsWith('@')) return l.slice(0, 200)
  }
  return null
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
function extractDoc(
  node: ts.Node,
  text: string,
  moduleEnd = -1,
): { doc: string | null; start: number } {
  const nodeStart = node.getStart(node.getSourceFile(), false)
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  // Блок, уже признанный модульным, физически является ведущим комментарием
  // ПЕРВОГО объявления. Отдать его ещё и объявлению — значит выдать описание
  // файла за описание функции; ровно эту подмену мы только что чинили
  // в обратную сторону.
  const jsdoc = [...ranges]
    .reverse()
    .find((r) => text.slice(r.pos, r.pos + 3) === '/**' && r.end > moduleEnd)
  if (!jsdoc) return { doc: null, start: nodeStart }

  const body = text.slice(jsdoc.pos, jsdoc.end)
  const first = body
    .split('\n')
    // Снимаем и открывающие `/**`/`*`, и закрывающий `*/` — иначе у однострочного
    // JSDoc хвост `*/` уезжает в заголовок каждого такого чанка.
    .map((l) =>
      l
        .replace(/^\s*\/?\*+/, '')
        .replace(/\*\/\s*$/, '')
        .trim(),
    )
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

export function parseFile(
  path: string,
  text: string,
  maxTokensPerNode: number,
  minTokensPerNode = 40,
): ParsedFile {
  const kind = scriptKindFor(path)
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)

  const imports: string[] = []
  const exports: string[] = []
  const candidates: Candidate[] = []
  // Имена, экспортированные по-CommonJS. Собираются вторым проходом, потому что
  // module.exports обычно стоит в конце файла, а пометить надо объявления выше.
  const commonJsExports = new Set<string>()

  const moduleEnd = moduleDocRange(text)?.end ?? -1

  const push = (
    node: ts.Node,
    symbol: string | null,
    chunkKind: ChunkKind,
    parents: string[],
    parentDoc: string | null = null,
  ) => {
    const { doc, start } = extractDoc(node, text, moduleEnd)
    candidates.push({
      symbol,
      kind: chunkKind,
      parentChain: parents,
      exported: isExported(node),
      doc,
      parentDoc,
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
        // Класс режется по методам: сам метод обычно описан скупо, а назначение
        // целого живёт в JSDoc класса — передаём его каждому методу.
        const classDoc = extractDoc(stmt, text, moduleEnd).doc
        for (const member of stmt.members) {
          if (
            ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ) {
            const mName = ts.isConstructorDeclaration(member) ? 'constructor' : nameOf(member)
            push(member, mName, 'method', symbol ? [symbol] : [], classDoc)
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
      if (fnDecls.length === 0) {
        // Не функция — но это не значит «не важно». В Keystone-подобных базах
        // `const UserRightsSet = new GQLListSchema(...)` и есть доменная логика,
        // а в целевой монорепе таких объявлений 6504. Раньше они уходили
        // в preamble, теряли имя и не находились по нему вообще.
        // Мелочь по-прежнему отдаём промежуткам: отдельный вектор на
        // `const A = 1` — чистый шум.
        if (approxTokens(stmt) >= minTokensPerNode) {
          const named = decls.find((d) => ts.isIdentifier(d.name))
          const symbol = named && ts.isIdentifier(named.name) ? named.name.text : null
          if (isExported(stmt) && symbol) exports.push(symbol)
          push(stmt, symbol, 'binding', [])
        }
        continue
      }

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
        const { doc, start } = extractDoc(stmt, text, moduleEnd)
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

    // module.exports = { A, B } / module.exports = X / exports.foo = ...
    // В целевой монорепе так экспортируют 2174 файла, и до этой ветки строка
    // `exports:` в обогащающем заголовке у них была пустой, а repo_map показывал
    // прочерк — при том что экспорт есть.
    if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
      const { left, right, operatorToken } = stmt.expression
      if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left)) {
        continue
      }
      const target = left.expression.getText(sourceFile)
      const isModuleExports = target === 'module' && left.name.text === 'exports'
      const isNamedExport = target === 'exports'

      if (isNamedExport) {
        commonJsExports.add(left.name.text)
      } else if (isModuleExports) {
        if (ts.isObjectLiteralExpression(right)) {
          for (const prop of right.properties) {
            const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null
            if (name) commonJsExports.add(name)
          }
        } else if (ts.isIdentifier(right)) {
          commonJsExports.add(right.text)
        }
      }
    }
  }

  for (const c of candidates) {
    if (c.symbol && commonJsExports.has(c.symbol)) c.exported = true
  }
  exports.push(...commonJsExports)

  candidates.sort((a, b) => a.start - b.start)
  return {
    imports: dedupe(imports),
    exports: dedupe(exports),
    candidates,
    sourceFile,
    moduleDoc: moduleDocOf(text),
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}
