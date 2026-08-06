#!/usr/bin/env node
import { Command } from 'commander'
import { migrate, status } from '../store/schema.js'
import { closeDb } from '../store/pool.js'
import { loadConfig, configPath } from '../config.js'

const program = new Command()
program.name('scs').description('Семантический поиск по коду').version('0.1.0')

program
  .command('migrate')
  .description('применить миграции БД')
  .action(async () => {
    const applied = await migrate()
    console.log(applied.length ? `Применено: ${applied.join(', ')}` : 'Миграции уже применены.')
  })

program
  .command('status')
  .description('состояние БД и индекса')
  .action(async () => {
    const cfg = loadConfig()
    console.log(`конфиг:   ${configPath()}`)
    console.log(`postgres: ${cfg.pg.replace(/:[^:@]*@/, ':***@')}`)
    console.log(`эмбеддер: ${cfg.embed.url} (${cfg.embed.backend}, ${cfg.embed.model})`)

    const s = await status()
    console.log(`миграции: ${s.migrations.join(', ') || '(нет)'}`)
    console.log(`чанков в базе: ${s.totalChunks}`)

    if (!s.repos.length) {
      console.log('\nРепозиториев нет. Добавьте: scs repo add <path> --name <name>')
      return
    }
    console.log('\nрепозиторий           файлов   чанков  последняя индексация')
    for (const r of s.repos) {
      const when = r.lastIndexed ? r.lastIndexed.toISOString().replace('T', ' ').slice(0, 19) : '—'
      console.log(
        `${r.name.padEnd(20)} ${String(r.files).padStart(7)} ${String(r.chunks).padStart(8)}  ${when}`,
      )
    }
  })

async function main() {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}

void main()
