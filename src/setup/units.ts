import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Сборка systemd-юнитов под конкретную машину.
 *
 * До этого юниты лежали в репозитории готовыми — с путём к node из nvm, домашним
 * каталогом автора и версией python внутри LD_LIBRARY_PATH. Работали ровно на
 * одной машине; «доставка» сводилась к «поправь три файла руками, ничего
 * не забыв». Здесь эти три места и параметризованы.
 */

export const UNITS = ['scs-embed', 'scs-rerank', 'scs-daemon'] as const
export type UnitName = (typeof UNITS)[number]

export interface UnitVars {
  /** Абсолютный путь к node: у user-сервисов своё окружение, nvm в нём нет. */
  node: string
  /** Корень установки — WorkingDirectory юнитов. */
  root: string
  /** Каталоги CUDA-библиотек; пустой список — реранкер пойдёт на CPU. */
  cudaLibs: string[]
  /** Цель автозапуска реранкера: default.target или graphical-session.target. */
  wantedBy: string
}

/**
 * Каталоги runtime-библиотек CUDA внутри локального venv.
 *
 * Ищем перебором, а не по фиксированному пути: `python3 -m venv` кладёт пакеты
 * в каталог с номером версии интерпретатора (`python3.14` на этой машине,
 * `python3.11` на другой), и зашитая версия — ровно та ошибка, из-за которой
 * юнит был непереносим.
 */
export function findCudaLibs(root: string): string[] {
  const venv = join(root, '.venv-cuda', 'lib')
  if (!existsSync(venv)) return []

  const dirs: string[] = []
  for (const py of readdirSync(venv)) {
    const nvidia = join(venv, py, 'site-packages', 'nvidia')
    if (!existsSync(nvidia)) continue
    for (const pkg of readdirSync(nvidia)) {
      const lib = join(nvidia, pkg, 'lib')
      if (existsSync(lib)) dirs.push(lib)
    }
  }
  return dirs.sort()
}

/**
 * Подстановка значений в шаблон юнита.
 *
 * Незаполненный placeholder — это отказ, а не предупреждение. Файл с `@NODE@`
 * в ExecStart systemd примет, юнит будет числиться установленным и упадёт при
 * запуске; на фоне трёх сервисов, один из которых и так умеет молча падать
 * на CPU, такую поломку легко не заметить.
 */
export function renderUnit(template: string, vars: UnitVars): string {
  const cudaEnv = vars.cudaLibs.length
    ? `Environment=LD_LIBRARY_PATH=${vars.cudaLibs.join(':')}`
    : '# CUDA-библиотеки не найдены: реранкер пойдёт на CPU (в 20 раз медленнее).\n' +
      '# Исправляется так: npm run cuda:libs && scs setup'

  const out = template
    .replaceAll('@NODE@', vars.node)
    .replaceAll('@ROOT@', vars.root)
    .replaceAll('@CUDA_ENV@', cudaEnv)
    .replaceAll('@WANTED_BY@', vars.wantedBy)

  const left = out.match(/@[A-Z_]+@/g)
  if (left) throw new Error(`в шаблоне остались неподставленные значения: ${[...new Set(left)].join(', ')}`)
  return out
}
