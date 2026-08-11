#!/usr/bin/env node
/**
 * Dev-бэкенд эмбеддера: контракт POST /embed поверх Ollama (CUDA).
 *
 * Prod-бэкенд (services/embed-npu, Ryzen AI + Vitis AI EP) реализует ЭТОТ ЖЕ контракт
 * байт-в-байт. TS-ядро не должно уметь отличать один от другого.
 *
 * Почему префиксы живут здесь, а не в клиенте: префикс — свойство модели.
 * Если его знает клиент, то при смене модели про него забудут, индекс и запросы
 * разъедутся, и качество упадёт молча. Клиент передаёт только kind.
 */
import { createServer, type IncomingMessage } from 'node:http'

const PORT = Number(process.env.SCS_EMBED_PORT ?? 8077)
const HOST = '127.0.0.1'
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.SCS_EMBED_MODEL ?? 'embeddinggemma:300m'
const DIMS = 768
const MAX_TOKENS = 2048

/**
 * Префиксы у каждой модели свои, и они не взаимозаменяемы.
 *
 * Перепутать их местами — самый дешёвый способ незаметно обрушить recall,
 * поэтому таблица задана здесь один раз и выбирается по имени модели.
 * У EmbeddingGemma префиксы асимметричны, у Qwen3 запрос оформляется
 * инструкцией, а документ идёт как есть, а jina-v2-base-code симметрична
 * и никаких префиксов не хочет вовсе.
 *
 * Модель, которой нет в таблице, запускать нельзя: молчаливый прогон без
 * префиксов — это как раз тот тихий отказ, ради которого таблица и заведена.
 */
const PREFIXES: Record<string, { query: string; document: string }> = {
  'embeddinggemma:300m': {
    // Альтернатива 'task: code retrieval | query: ' проверена и отвергнута (§15).
    query: 'task: search result | query: ',
    document: 'title: none | text: ',
  },
  'qwen3-embedding:0.6b': {
    query: 'Instruct: Given a question about a codebase, retrieve the code that answers it\nQuery: ',
    document: '',
  },
  'unclemusclez/jina-embeddings-v2-base-code': { query: '', document: '' },
}

const PREFIX = PREFIXES[MODEL] ?? PREFIXES[MODEL.replace(/:latest$/, '')]
if (!PREFIX) {
  throw new Error(
    `для модели ${MODEL} не заданы префиксы. Добавьте их в PREFIXES: запуск без ` +
      `префиксов молча ухудшит качество, а не упадёт.`,
  )
}
if (process.env.SCS_QUERY_PREFIX) PREFIX.query = process.env.SCS_QUERY_PREFIX

/**
 * Схлопывание пробельных серий перед подачей в модель.
 *
 * Не косметика, а обход измеренного узкого места. На настоящих чанках кода
 * (946 символов, 30 строк в среднем) Ollama 0.13.5 выдаёт 1.9 чанка/с, при этом
 * GPU загружен на 1–10%, а рантайм жжёт ~300% CPU: время съедает подготовка
 * входа, а не инференс. Виноваты именно серии пробельных символов — отступы
 * и переносы. Замер на одном и том же наборе чанков:
 *
 *   как есть               1.9 чанк/с
 *   переносы → пробел      2.9 чанк/с   (отступы остаются — почти не помогает)
 *   схлопнуть все серии   91.3 чанк/с   (×48)
 *
 * Для монорепы это разница между «индексация 10 минут» и «индексация 7 часов»,
 * то есть между выполненным и невыполненным критерием §1.
 *
 * Нормализация живёт здесь, а не в чанкере, по той же причине, что и префиксы:
 * это свойство бэкенда, и вызывающий код не должен уметь про неё забыть. Режим
 * входит в возвращаемый model, поэтому его переключение автоматически обесценивает
 * индекс (content_hash считается от model_id) и не смешивает несравнимые вектора.
 */
const COLLAPSE_WS = (process.env.SCS_EMBED_WS ?? 'collapse') === 'collapse'
const MODEL_ID = COLLAPSE_WS ? `${MODEL}+ws` : MODEL

function forModel(text: string): string {
  return COLLAPSE_WS ? text.replace(/\s+/g, ' ').trim() : text
}

/** Оценка только для флага truncated; истину знает токенизатор модели. */
const CHARS_PER_TOKEN = 3.2

function l2normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return v
  return v.map((x) => x / norm)
}

/**
 * Matryoshka-усечение до размерности схемы.
 *
 * Схема БД фиксирует vector(768) (§5), а Qwen3-Embedding отдаёт 1024. Обе модели
 * обучены с Matryoshka-представлением, поэтому первые 768 координат — это
 * самостоятельный корректный вектор, но ТОЛЬКО после повторной нормализации:
 * у усечённого вектора длина уже не единичная, и косинус перестаёт совпадать
 * со скалярным произведением.
 *
 * Усечение — не бесплатная операция, и в A/B-сравнении моделей это работает
 * против Qwen3. Если она выиграет даже так, вывод только крепче.
 */
function toSchemaDims(v: number[]): number[] {
  return l2normalize(v.length > DIMS ? v.slice(0, DIMS) : v)
}

async function ollamaEmbed(inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  })
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = (await res.json()) as { embeddings?: number[][] }
  if (!data.embeddings || data.embeddings.length !== inputs.length) {
    throw new Error(
      `Ollama вернул ${data.embeddings?.length ?? 0} векторов на ${inputs.length} входов`,
    )
  }
  return data.embeddings
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('тело запроса больше 64 МБ'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, {
        backend: 'ollama',
        model: MODEL_ID,
        dims: DIMS,
        maxTokens: MAX_TOKENS,
        ready: true,
      })
    }

    if (req.method === 'POST' && req.url === '/embed') {
      const body = JSON.parse(await readBody(req)) as {
        inputs?: unknown
        kind?: unknown
        dims?: unknown
      }

      const inputs = body.inputs
      if (!Array.isArray(inputs) || inputs.some((s) => typeof s !== 'string')) {
        return send(400, { error: 'inputs должен быть массивом строк' })
      }
      const kind = body.kind === 'query' ? 'query' : 'document'
      if (body.dims !== undefined && body.dims !== DIMS) {
        return send(400, { error: `эта модель отдаёт ${DIMS} измерений, запрошено ${body.dims}` })
      }
      if (inputs.length === 0) {
        return send(200, { vectors: [], model: MODEL_ID, dims: DIMS, normalized: true, truncated: [] })
      }

      const prefixed = (inputs as string[]).map((s) => forModel(PREFIX[kind] + s))
      const raw = await ollamaEmbed(prefixed)

      for (const [i, v] of raw.entries()) {
        if (v.length < DIMS) {
          return send(500, { error: `вектор ${i} имеет ${v.length} измерений, меньше требуемых ${DIMS}` })
        }
      }

      return send(200, {
        vectors: raw.map(toSchemaDims),
        model: MODEL_ID,
        dims: DIMS,
        normalized: true,
        // Оценка по символам: Ollama не отдаёт токены по каждому входу отдельно.
        // NPU-бэкенд токенизирует сам и вернёт здесь точное значение.
        truncated: prefixed.map((s) => s.length / CHARS_PER_TOKEN > MAX_TOKENS),
      })
    }

    send(404, { error: 'нет такого маршрута' })
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`embed-ollama: http://${HOST}:${PORT} → ${OLLAMA} (${MODEL}, ${DIMS}d)`)
})
