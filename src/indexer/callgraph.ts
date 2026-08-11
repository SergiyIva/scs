import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptKindFor } from '../chunker/typescript.js'

/**
 * Кто кого вызывает — статическим проходом, без LLM и без резолва типов.
 *
 * Зачем (эксперимент C, RECALL85 §4.5). Доминирующий класс промахов —
 * «механизм вместо назначения»: чанк описывает, КАК это сделано, а вопрос
 * спрашивает, ЗАЧЕМ. Назначение часто известно вызывающему: `verifySecret`
 * сам по себе — это сравнение строк, но вызывается он из обработчика вебхука,
 * и именно это связывает его с вопросом «как сервер проверяет подлинность
 * уведомления». LLM в §3.5 синтезировала ровно такой мост; здесь мы берём
 * его из кода, где он уже есть.
 *
 * Осознанные ограничения, чтобы не построить приблизительный граф вызовов
 * рядом с точным LSP (DESIGN §15 прямо отвергает такую затею):
 *
 * - только имена, без резолва: одноимённые символы из разных файлов сливаются;
 * - в заголовок идут не более трёх вызывающих, и это ограничивает транзитивную
 *   инвалидацию — правка вызывающего меняет заголовок вызываемого, то есть его
 *   content_hash. Три имени вместо всех означают, что лавина пересчёта
 *   на рефакторинге ограничена сверху;
 * - имена сортируются, чтобы порядок обхода файлов не менял хэш.
 */

export type CallMap = Map<string, string[]>

const MAX_CALLERS = 3
/** Слишком общие имена: их «вызывающие» не несут смысла, зато инвалидируют всё. */
const IGNORED = new Set([
  'map', 'filter', 'forEach', 'reduce', 'push', 'then', 'catch', 'log', 'error',
  'warn', 'get', 'set', 'has', 'add', 'delete', 'test', 'expect', 'describe', 'it',
  'require', 'join', 'split', 'slice', 'toString', 'keys', 'values', 'entries',
])

/** Имя ближайшего объявления, внутри которого стоит узел. */
function enclosingName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      const name = n.name && ts.isIdentifier(n.name) ? n.name.text : null
      if (name) return name
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text
    if (ts.isClassDeclaration(n) && n.name) return n.name.text
  }
  return null
}

/** Имя вызываемого: `foo()` и `obj.foo()` считаются одним и тем же `foo`. */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return null
}

export async function buildCallMap(root: string, paths: string[]): Promise<CallMap> {
  const callers = new Map<string, Set<string>>()

  for (const path of paths) {
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)) continue
    let text: string
    try {
      text = await readFile(join(root, path), 'utf8')
    } catch {
      continue
    }
    if (text.length > 512 * 1024) continue

    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path))
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression)
        if (callee && !IGNORED.has(callee) && callee.length > 2) {
          const from = enclosingName(node)
          // Самовызов и рекурсия ничего не добавляют к назначению.
          if (from && from !== callee) {
            const set = callers.get(callee) ?? new Set<string>()
            set.add(from)
            callers.set(callee, set)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  const out: CallMap = new Map()
  for (const [callee, from] of callers) {
    // Сортировка обязательна: без неё порядок зависит от обхода файловой
    // системы, и один и тот же код давал бы разные content_hash.
    out.set(callee, [...from].sort().slice(0, MAX_CALLERS))
  }
  return out
}
