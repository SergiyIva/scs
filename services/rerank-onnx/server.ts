#!/usr/bin/env node
/**
 * Cross-encoder реранкер за HTTP-контрактом.
 *
 * Зачем отдельный сервис, а не библиотека внутри ядра: ровно та же причина, что
 * у эмбеддера (§2). Модель — это железозависимая часть, и на целевой машине
 * (AMD NPU) она поедет другим рантаймом. Контракт остаётся, реализация меняется.
 *
 * Почему вообще реранкер: замер §19 показал, что правильный ответ лежит в первых
 * 50 кандидатах в 67.2% случаев, но в первых пяти — только в 37.9%. Двадцать
 * девять пунктов разницы — это не полнота, а порядок, и переупорядочивание
 * парным сравнением «запрос ↔ документ» ровно для этого и существует.
 *
 * Bi-encoder (наш эмбеддер) кодирует запрос и документ независимо, поэтому дёшев
 * и годится для отбора из 54 тысяч. Cross-encoder читает пару целиком, поэтому
 * точнее и дороже на три порядка — его пускают только по короткому списку.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

const PORT = Number(process.env.SCS_RERANK_PORT ?? 8090)
const HOST = '127.0.0.1'
const MODEL = process.env.SCS_RERANK_MODEL ?? 'onnx-community/bge-reranker-v2-m3-ONNX'
const DTYPE = (process.env.SCS_RERANK_DTYPE ?? 'q8') as 'q8' | 'fp32' | 'fp16'
const DEVICE = process.env.SCS_RERANK_DEVICE as 'cpu' | 'cuda' | undefined
const MAX_LENGTH = Number(process.env.SCS_RERANK_MAX_LENGTH ?? 256)
/** Размер батча пар. Больше — быстрее, но память растёт как batch × maxLength². */
const BATCH = Number(process.env.SCS_RERANK_BATCH ?? 16)

const tokenizer = await AutoTokenizer.from_pretrained(MODEL)

/**
 * Устройство выбирается замером, а не верой.
 *
 * Разница принципиальная: 20 пар на GPU в fp16 считаются 121 мс, на CPU в q8 —
 * 2.6 с. Это разница между «реранкер включён всегда» и «реранкер выключен
 * по умолчанию». При этом q8 на GPU почти не выигрывает (1.6 с): CUDA-провайдер
 * плохо работает с целочисленной квантизацией, ему нужен fp16.
 *
 * Пробуем GPU, при неудаче честно падаем на CPU и пишем об этом в лог: молча
 * работающий в тридцать раз медленнее сервис — худший из возможных исходов.
 */
async function loadModel() {
  const wanted = DEVICE ?? 'cuda'
  if (wanted !== 'cpu') {
    try {
      const m = await AutoModelForSequenceClassification.from_pretrained(MODEL, {
        dtype: DEVICE ? DTYPE : 'fp16',
        device: 'cuda',
      })
      return { model: m, device: 'cuda', dtype: DEVICE ? DTYPE : 'fp16' }
    } catch (err) {
      if (DEVICE === 'cuda') throw err
      console.error(
        `[rerank] GPU недоступен, работаем на CPU (медленнее в ~20 раз): ` +
          `${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      )
    }
  }
  const m = await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: DTYPE })
  return { model: m, device: 'cpu', dtype: DTYPE }
}

const loaded = await loadModel()
const model = loaded.model

/**
 * Логит cross-encoder ничем не ограничен и в этой модели живёт примерно
 * в диапазоне −11…+11. Наружу отдаём сигмоиду: вызывающий код умножает скор
 * на априорные множители (§8), а множитель на отрицательном числе улучшает
 * результат вместо того, чтобы ухудшать.
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

async function rerank(query: string, documents: string[]): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < documents.length; i += BATCH) {
    const batch = documents.slice(i, i + BATCH)
    const inputs = tokenizer(Array<string>(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
      max_length: MAX_LENGTH,
    })
    const { logits } = await model(inputs)
    for (const row of logits.tolist() as number[][]) out.push(sigmoid(row[0] ?? 0))
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 32 * 1024 * 1024) {
        reject(new Error('тело запроса больше 32 МБ'))
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
        model: MODEL,
        dtype: loaded.dtype,
        device: loaded.device,
        maxLength: MAX_LENGTH,
        ready: true,
      })
    }

    if (req.method === 'POST' && req.url === '/rerank') {
      const body = JSON.parse(await readBody(req)) as { query?: unknown; documents?: unknown }
      if (typeof body.query !== 'string') return send(400, { error: 'query должен быть строкой' })
      if (!Array.isArray(body.documents) || body.documents.some((d) => typeof d !== 'string')) {
        return send(400, { error: 'documents должен быть массивом строк' })
      }
      if (body.documents.length === 0) return send(200, { scores: [], model: MODEL })

      const started = Date.now()
      const scores = await rerank(body.query, body.documents as string[])
      return send(200, { scores, model: MODEL, ms: Date.now() - started })
    }

    send(404, { error: 'нет такого маршрута' })
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`rerank-onnx: http://${HOST}:${PORT} → ${MODEL} (${loaded.dtype}, ${loaded.device})`)
})
