import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { packageRoot } from '../src/util/root.js'
import { UNITS, findCudaLibs, renderUnit } from '../src/setup/units.js'

/**
 * Юниты и корень установки — то, что ломается не у нас, а у пользователя.
 *
 * Обе проверенные здесь ошибки в проекте уже были: путь к миграциям считался
 * шагами вверх и из dist/ промахивался, а юниты содержали домашний каталог
 * автора, версию node из nvm и версию python в LD_LIBRARY_PATH. Ни то, ни другое
 * не проявлялось при разработке — только при установке на другую машину.
 */

const root = packageRoot()

const vars = {
  node: '/opt/node/bin/node',
  root: '/srv/scs',
  cudaLibs: ['/srv/scs/.venv-cuda/lib/python3.11/site-packages/nvidia/cublas/lib'],
  wantedBy: 'default.target',
}

test('корень установки находится по package.json, а не отсчётом уровней', () => {
  // Тот же вызов из другой глубины обязан дать тот же ответ — иначе повторяется
  // ровно тот промах, из-за которого `scs migrate` искал migrations в dist/.
  assert.equal(packageRoot(join(root, 'src', 'store', 'schema.ts')), root)
  assert.equal(packageRoot(join(root, 'dist', 'src', 'bin', 'scs.js')), root)
  assert.ok(readdirSync(join(root, 'migrations')).some((f) => f.endsWith('.sql')))
})

test('в собранных юнитах не остаётся placeholder’ов', () => {
  for (const name of UNITS) {
    const tpl = readFileSync(join(root, 'packaging', `${name}.service.in`), 'utf8')
    const out = renderUnit(tpl, vars)
    assert.doesNotMatch(out, /@[A-Z_]+@/, `${name}: остался placeholder`)
    assert.match(out, /^ExecStart="\/opt\/node\/bin\/node" /m, `${name}: не подставлен node`)
    assert.match(out, /^WorkingDirectory=\/srv\/scs$/m, `${name}: не подставлен корень`)
  }
})

test('неизвестный placeholder не проходит молча', () => {
  // Молчаливый пропуск дал бы установленный юнит, падающий при старте:
  // systemd такой файл принимает без возражений.
  assert.throws(
    () => renderUnit('ExecStart=@NODE@ @OOPS@', vars),
    /@OOPS@/,
    'подстановка не заметила неизвестного placeholder’а',
  )
})

test('без CUDA юнит реранкера остаётся валидным и объясняет деградацию', () => {
  const tpl = readFileSync(join(root, 'packaging', 'scs-rerank.service.in'), 'utf8')
  const out = renderUnit(tpl, { ...vars, cudaLibs: [] })
  assert.doesNotMatch(out, /^Environment=LD_LIBRARY_PATH=$/m, 'пустой LD_LIBRARY_PATH')
  assert.match(out, /CPU/, 'юнит молчит о том, что реранкер уйдёт на CPU')
})

test('поиск CUDA-библиотек не зависит от версии python в пути', (t) => {
  // На своей фикстуре, а не на .venv-cuda этой машины: прежняя версия выходила
  // при пустом результате, то есть на машине без venv проверяла ровно ничего
  // и при этом отчитывалась как пройденная.
  const tmp = mkdtempSync(join(tmpdir(), 'scs-cuda-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  // Версия намеренно небывалая: если поиск её находит, значит номер не зашит.
  const lib = join(tmp, '.venv-cuda/lib/python3.99/site-packages/nvidia/cublas/lib')
  mkdirSync(lib, { recursive: true })
  // Каталог без lib внутри не должен попасть в LD_LIBRARY_PATH.
  mkdirSync(join(tmp, '.venv-cuda/lib/python3.99/site-packages/nvidia/cuda_nvcc'), {
    recursive: true,
  })

  assert.deepEqual(findCudaLibs(tmp), [lib])
})

test('пути с пробелами не разваливают юнит', () => {
  // Проверено systemd-analyze: без кавычек ExecStart рвётся по пробелу
  // («Command ... is not executable»), а Environment теряет хвост
  // («Invalid environment assignment, ignoring») — и реранкер молча уходит
  // на CPU. WorkingDirectory, наоборот, кавычки ломают: она берёт строку целиком.
  const spaced = {
    node: '/opt/my node/bin/node',
    root: '/srv/my scs',
    cudaLibs: ['/srv/my scs/.venv-cuda/lib/python3.11/site-packages/nvidia/cublas/lib'],
    wantedBy: 'default.target',
  }
  const tpl = readFileSync(join(root, 'packaging', 'scs-rerank.service.in'), 'utf8')
  const out = renderUnit(tpl, spaced)

  assert.match(out, /^ExecStart="\/opt\/my node\/bin\/node" dist\//m, 'путь к node не закавычен')
  assert.match(out, /^Environment="LD_LIBRARY_PATH=\/srv\/my scs\/[^"]*"$/m, 'Environment не закавычен')
  assert.match(out, /^WorkingDirectory=\/srv\/my scs$/m, 'WorkingDirectory не должен быть в кавычках')
})

test('кавычки и обратные слэши в пути экранируются', () => {
  const out = renderUnit('ExecStart=@NODE@ x.js', { ...vars, node: '/o"pt/no\\de' })
  assert.match(out, /^ExecStart="\/o\\"pt\/no\\\\de" x\.js$/m)
})

/**
 * Приговор выносит systemd, а не наши регулярные выражения.
 *
 * Проверка не теоретическая: именно она нашла, что StartLimitIntervalSec стоял
 * в [Service], где systemd его игнорирует, — защита от цикла рестартов не
 * работала, и никаких признаков этого не было. Собственными assert'ами такое
 * не поймать: надо знать, какие ключи в какой секции допустимы.
 */
test('systemd принимает собранные юниты без нареканий', (t) => {
  if (spawnSync('systemd-analyze', ['--version']).status !== 0) {
    t.skip('systemd-analyze недоступен')
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'scs-units-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  // Пути должны существовать: verify проверяет исполняемость ExecStart.
  const real = {
    ...vars,
    node: process.execPath,
    root,
    cudaLibs: findCudaLibs(root),
    sessionBinding: 'graphical-session.target',
  }

  for (const name of UNITS) {
    const file = join(tmp, `${name}.service`)
    const tpl = readFileSync(join(root, 'packaging', `${name}.service.in`), 'utf8')
    writeFileSync(file, renderUnit(tpl, real))

    const res = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' })
    // verify обходит и чужие юниты системы, ворча на них: берём только строки
    // про наш файл, иначе тест будет падать из-за постороннего spice-vdagent.
    const ours = `${res.stdout}${res.stderr}`
      .split('\n')
      .filter((l) => l.includes(tmp) || l.startsWith(`${name}.service`))
    assert.deepEqual(ours, [], `${name}: systemd недоволен`)
  }
})

test('реранкер не поднимается при загрузке ОС', () => {
  // Смысл --boot: индексация продолжается без сессии, но 2+ ГБ видеопамяти
  // на пустой машине не занимаются. Если цель перепутать, экономия исчезнет молча.
  const tpl = readFileSync(join(root, 'packaging', 'scs-rerank.service.in'), 'utf8')
  const boot = renderUnit(tpl, {
    ...vars,
    wantedBy: 'graphical-session.target',
    sessionBinding: 'graphical-session.target',
  })
  assert.match(boot, /^WantedBy=graphical-session\.target$/m)
  // WantedBy только запускает. Без PartOf реранкер пережил бы выход из системы
  // и продолжил держать видеопамять — экономия существовала бы лишь на бумаге.
  assert.match(boot, /^PartOf=graphical-session\.target$/m, 'реранкер не остановится с сессией')

  // В обычном режиме привязки к сессии быть не должно: там он живёт с default.target.
  assert.doesNotMatch(renderUnit(tpl, vars), /^PartOf=/m, 'лишняя привязка к сессии')

  for (const name of ['scs-embed', 'scs-daemon']) {
    const tpl = readFileSync(join(root, 'packaging', `${name}.service.in`), 'utf8')
    assert.match(renderUnit(tpl, vars), /^WantedBy=default\.target$/m, `${name} не поднимется с ОС`)
  }
})
