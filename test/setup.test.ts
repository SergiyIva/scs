import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
    assert.match(out, /^ExecStart=\/opt\/node\/bin\/node /m, `${name}: не подставлен node`)
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

test('поиск CUDA-библиотек не зависит от версии python в пути', () => {
  const found = findCudaLibs(root)
  if (!found.length) return // на машине без venv проверять нечего
  assert.ok(
    found.every((p) => p.endsWith('/lib')),
    'в списке оказалось не то, что кладётся в LD_LIBRARY_PATH',
  )
  assert.ok(found.some((p) => p.includes('cublas')), 'не найден cublas')
})

test('реранкер не поднимается при загрузке ОС', () => {
  // Смысл --boot: индексация продолжается без сессии, но 2+ ГБ видеопамяти
  // на пустой машине не занимаются. Если цель перепутать, экономия исчезнет молча.
  const tpl = readFileSync(join(root, 'packaging', 'scs-rerank.service.in'), 'utf8')
  const boot = renderUnit(tpl, { ...vars, wantedBy: 'graphical-session.target' })
  assert.match(boot, /^WantedBy=graphical-session\.target$/m)

  for (const name of ['scs-embed', 'scs-daemon']) {
    const tpl = readFileSync(join(root, 'packaging', `${name}.service.in`), 'utf8')
    assert.match(renderUnit(tpl, vars), /^WantedBy=default\.target$/m, `${name} не поднимется с ОС`)
  }
})
