/**
 * Приблизительный счётчик токенов для планирования размера чанков.
 *
 * Настоящий токенизатор Gemma сюда тащить не стоит: он нужен только чтобы
 * решить, где резать, а истину о переполнении контекста возвращает сам
 * эмбеддинг-сервис в поле `truncated`. Код токенизируется плотнее прозы
 * из-за пунктуации и идентификаторов — эмпирически ~3.2 символа на токен.
 */
const CHARS_PER_TOKEN = 3.2

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}
