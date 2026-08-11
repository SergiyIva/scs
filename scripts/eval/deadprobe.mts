/** Мёртвые запросы (ответ вне топ-1000 при любом варианте с gemma3:4b): спасает ли генератор покрупнее. */
import { db, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'

const MODEL = process.env.QX_MODEL ?? 'qwen3-vl:8b'
const QUERIES: { q: string; expect: string[] }[] = [
  {
    q: 'как сервер убеждается, что уведомление о смене статуса оплаты пришло от настоящего провайдера, а не от постороннего',
    expect: ['apps/condo/domains/acquiring/integrations/infra/adapters/mydom/MyDomWebhookAdapter.ts::verifySecret'],
  },
  {
    q: 'how is an incoming payment status callback authenticated so that a stranger cannot fake it',
    expect: ['apps/condo/domains/acquiring/integrations/infra/adapters/mydom/MyDomWebhookAdapter.ts::verifySecret'],
  },
  {
    q: 'где перечислены галочки полномочий, которые можно выдать сотруднику поддержки',
    expect: ['apps/condo/domains/user/schema/UserRightsSet.js::UserRightsSet'],
  },
]

const embedder = new Embedder()
const modelId = await embedder.model()

async function gen(q: string) {
  const prompt =
    `Ты помогаешь искать код в JS/TS-монорепе платформы управляющей компании ` +
    `(биллинг, приём платежей, заявки жильцов, приборы учёта, организации, документооборот; ` +
    `backend Node/Keystone c GraphQL-схемами, frontend React).\n` +
    `Вопрос: «${q}»\n` +
    `Выведи JSON с полями: keywords — 10-14 английских терминов, которые вероятно встречаются ` +
    `в искомом фрагменте кода (имена функций/констант в camelCase или SCREAMING_SNAKE_CASE, доменные слова); ` +
    `code — гипотетический фрагмент JS 5-12 строк, как мог бы выглядеть ответ: реалистичные имена, ` +
    `короткий английский JSDoc о назначении.`
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL, prompt, stream: false, format: 'json',
      options: { temperature: 0.3, num_predict: 500 },
    }),
  })
  const data = (await res.json()) as { response: string; thinking?: string }
  try {
    const p = JSON.parse(data.response || data.thinking || '')
    return { keywords: (p.keywords ?? []).map(String), code: String(p.code ?? '') }
  } catch {
    return { keywords: [], code: '' }
  }
}

const rank = async (v: number[], wanted: Set<string>) => {
  const { rows } = await db().query<{ path: string; symbol: string | null; parent_chain: string[] }>(
    `SELECT l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
      ORDER BY c.embedding <=> $1::vector LIMIT 2000`,
    [toVectorLiteral(v), modelId, ],
  )
  const i = rows.findIndex(
    (r) =>
      wanted.has(r.path) ||
      (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
      (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`)),
  )
  return i < 0 ? null : i + 1
}

for (const { q, expect } of QUERIES) {
  const wanted = new Set(expect)
  const { keywords, code } = await gen(q)
  console.log(`\n«${q.slice(0, 70)}»`)
  console.log(`  keywords: ${keywords.join(', ').slice(0, 160)}`)
  console.log(`  code: ${code.split('\n').slice(0, 3).join(' | ').slice(0, 160)}`)
  const [vKw] = await embedder.embed([`${q}\n${keywords.join(' ')}`], 'query')
  const [vHydeD] = await embedder.embed([code || q], 'document')
  const { rows: lexRows } = await db().query<{ path: string; symbol: string | null; parent_chain: string[] }>(
    `SELECT l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id,
            code_query($1) tq
      WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
        AND tq != ''::tsquery AND c.tsv @@ tq
      ORDER BY ts_rank(c.tsv, tq) DESC LIMIT 2000`,
    [keywords.join(' '), modelId],
  )
  const li = lexRows.findIndex(
    (r) =>
      wanted.has(r.path) ||
      (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
      (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`)),
  )
  console.log(`  ранги: kw=${await rank(vKw!, wanted)} hydeD=${await rank(vHydeD!, wanted)} lex=${li < 0 ? '—' : li + 1}`)
}
await closeDb()
