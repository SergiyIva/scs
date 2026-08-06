import picomatch from 'picomatch'

/**
 * Deny-list — одновременно про качество поиска и про безопасность.
 *
 * Секрет, попавший в векторную базу, — это секрет, который уедет в контекст
 * облачной модели при первом же релевантном запросе. Поэтому список строгий
 * по умолчанию, а расширяется только осознанно через конфиг.
 */
export const DEFAULT_DENY = [
  // секреты
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/credentials*',
  '**/secrets/**',
  // артефакты сборки и зависимости
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/__generated__/**',
  // машинный вывод
  '**/*.min.js',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/*.d.ts',
  // Машинно-собранная история версий: тысячи строк одинаковых формулировок,
  // которые лексически и семантически шумят, но ни на один вопрос не отвечают.
  '**/CHANGELOG.md',
]

const SUPPORTED_EXT = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  // Документация написана тем же естественным языком, которым задаются запросы,
  // поэтому по отдаче на строку это самый ценный источник в корпусе.
  'md',
  'mdx',
  'markdown',
])

export const MAX_FILE_BYTES = 1024 * 1024

export function makeFilter(extraDeny: string[] = []) {
  const isDenied = picomatch([...DEFAULT_DENY, ...extraDeny], { dot: true })

  return (path: string): boolean => {
    const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
    if (!ext || !SUPPORTED_EXT.has(ext)) return false
    return !isDenied(path)
  }
}

/**
 * Эвристики поверх имени файла: бинарники и машинно-сгенерированный код
 * не несут смысла, но раздувают индекс и ломают ранжирование.
 */
export function looksIndexable(
  content: string,
  bytes: number,
  path = '',
): { ok: boolean; reason?: string } {
  if (bytes > MAX_FILE_BYTES) return { ok: false, reason: `больше ${MAX_FILE_BYTES} байт` }
  // Нулевой байт — надёжный признак бинарника. Экранирован намеренно:
  // буквальный NUL в исходнике заставляет grep и diff считать файл бинарным.
  if (content.includes('\u0000')) return { ok: false, reason: 'бинарный файл' }

  // Порог минификации применим только к коду. В прозе абзац часто написан одной
  // длинной строкой без переносов, и общий порог 200 молча выбрасывал бы из
  // индекса нормальную документацию — тот самый класс тихой потери, ради
  // которого мы отказались от обрезки чанков.
  const limit = /\.(md|mdx|markdown)$/i.test(path) ? 2000 : 200
  const lines = content.split('\n')
  if (lines.length > 0) {
    const avg = content.length / lines.length
    if (avg > limit) {
      return { ok: false, reason: `средняя длина строки ${Math.round(avg)} — минифицировано` }
    }
  }
  return { ok: true }
}
