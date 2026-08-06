#!/usr/bin/env node
import { runStdio } from '../mcp/server.js'

/**
 * Транспорт stdio: всё, что попадёт в stdout, будет разобрано как MCP-протокол.
 * Поэтому любая диагностика обязана идти в stderr, иначе она ломает сессию.
 */
runStdio().catch((err: unknown) => {
  process.stderr.write(`scs-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
