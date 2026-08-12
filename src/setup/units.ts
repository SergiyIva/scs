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
  /**
   * Цель, вместе с которой реранкер обязан останавливаться (PartOf).
   *
   * Без неё привязка к сессии однобока: WantedBy юнит только ЗАПУСКАЕТ, а после
   * выхода из системы он продолжает работать и держать видеопамять — то есть
   * ровно то, ради чего затевался --boot, не происходит, и молча.
   */
  sessionBinding?: string
}

/**
 * Значение для директив, которые systemd разбивает по пробелам (ExecStart,
 * Environment). Проверено `systemd-analyze verify`: без кавычек путь с пробелом
 * даёт «Command ... is not executable» и «Invalid environment assignment,
 * ignoring» — второе особенно неприятно, потому что сервис при этом стартует
 * и молча уходит на CPU.
 */
function sdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
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
    ? `Environment=${sdQuote(`LD_LIBRARY_PATH=${vars.cudaLibs.join(':')}`)}`
    : '# CUDA-библиотеки не найдены: реранкер пойдёт на CPU (в 20 раз медленнее).\n' +
      '# Исправляется так: npm run cuda:libs && scs setup'

  const out = template
    // ExecStart systemd разбивает по пробелам, поэтому путь к node — в кавычках.
    .replaceAll('@NODE@', sdQuote(vars.node))
    // А WorkingDirectory берёт значение целиком, и кавычки её ЛОМАЮТ:
    // systemd-analyze на закавыченном пути отвечает «path is not absolute».
    // Разные директивы — разные правила, общего экранирования тут нет.
    .replaceAll('@ROOT@', vars.root)
    .replaceAll('@CUDA_ENV@', cudaEnv)
    .replaceAll('@SESSION_BINDING@', vars.sessionBinding ? `PartOf=${vars.sessionBinding}` : '')
    .replaceAll('@WANTED_BY@', vars.wantedBy)

  const left = out.match(/@[A-Z_]+@/g)
  if (left) throw new Error(`в шаблоне остались неподставленные значения: ${[...new Set(left)].join(', ')}`)
  return out
}
