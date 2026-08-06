import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PathQueue } from '../src/indexer/queue.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('одинаковые пути схлопываются в один', async () => {
  const flushes: string[][] = []
  const q = new PathQueue({
    debounceMs: 30,
    maxPaths: 100,
    onFlush: async (paths) => {
      flushes.push(paths)
    },
  })

  // Сборщик трогает один файл по многу раз за секунду — без дедупа очередь
  // распухает на порядок, а работа выполняется одна и та же.
  for (let i = 0; i < 20; i++) q.add('src/a.ts')
  q.add('src/b.ts')
  await wait(80)

  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0]!.sort(), ['src/a.ts', 'src/b.ts'])
  q.stop()
})

test('дебаунс откладывает обработку до затишья', async () => {
  const flushes: string[][] = []
  const q = new PathQueue({
    debounceMs: 60,
    maxPaths: 100,
    onFlush: async (paths) => {
      flushes.push(paths)
    },
  })

  q.add('a')
  await wait(30)
  assert.equal(flushes.length, 0, 'сработало раньше затишья')
  q.add('b') // сдвигает таймер
  await wait(30)
  assert.equal(flushes.length, 0, 'таймер не сдвинулся при новом событии')
  await wait(60)
  assert.equal(flushes.length, 1)
  q.stop()
})

/**
 * `git checkout` другой ветки меняет тысячи файлов. Поштучная обработка тут
 * дороже, чем один полный диф по `git ls-files -s`, поэтому очередь обязана
 * сообщить о переполнении, а не молча тянуть лавину.
 */
test('переполнение сбрасывает очередь немедленно и с другой причиной', async () => {
  const reasons: string[] = []
  const q = new PathQueue({
    debounceMs: 10_000, // заведомо больше теста: сработать должно не по таймеру
    maxPaths: 5,
    onFlush: async (_paths, reason) => {
      reasons.push(reason)
    },
  })

  for (let i = 0; i < 5; i++) q.add(`file${i}.ts`)
  await wait(20)

  assert.deepEqual(reasons, ['overflow'])
  q.stop()
})

test('события во время обработки не теряются', async () => {
  const flushes: string[][] = []
  const q = new PathQueue({
    debounceMs: 20,
    maxPaths: 100,
    onFlush: async (paths) => {
      flushes.push(paths)
      // Длинная обработка: правка, пришедшая внутри неё, обязана попасть
      // в следующий проход, а не пропасть.
      await wait(60)
    },
  })

  q.add('first.ts')
  await wait(40)
  q.add('second.ts')
  await wait(150)

  assert.equal(flushes.length, 2, `ожидали два прохода, получили ${flushes.length}`)
  assert.deepEqual(flushes[0], ['first.ts'])
  assert.deepEqual(flushes[1], ['second.ts'])
  q.stop()
})
