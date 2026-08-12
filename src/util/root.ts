import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Корень установки — каталог с package.json, migrations и packaging.
 *
 * Считать его как «N уровней вверх от текущего файла» нельзя: из `src/` и из
 * `dist/src/` глубина разная. Ровно на этом ломался `scs migrate` в собранном
 * виде — искал миграции в `dist/migrations` и падал с ENOENT. Пока разработка
 * шла через tsx, ошибка не проявлялась: у пользователя она вылезала бы на самой
 * первой команде.
 *
 * Поэтому идём вверх до package.json, а не отсчитываем шаги.
 */
export function packageRoot(from: string = import.meta.url): string {
  let dir = dirname(from.startsWith('file:') ? fileURLToPath(from) : from)
  const { root } = parse(dir)

  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    if (dir === root) throw new Error(`не нашёл package.json вверх от ${from}`)
    dir = dirname(dir)
  }
}
