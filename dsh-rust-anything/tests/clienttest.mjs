// Tests host/mcp-client.js against tests/fixtures/fake-mcp-cli.mjs — no DSH, no rust-anything.
//
//   node tests/clienttest.mjs
//
// Covers the wire contract the plugin depends on: initialize handshake, tools/list with the
// schemas passed through, tools/call success and isError results, the server's list_changed
// notification, cancellation, a clean stop, and a refusal to call after stop.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const FIXTURE = path.join(HERE, 'fixtures', 'fake-mcp-cli.mjs')

const failures = []
const pass = (name, detail = '') => console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
  console.log(`  FAIL ${name} — ${detail}`)
}
const check = (name, condition, detail = '') => (condition ? pass(name, detail) : fail(name, detail || 'condition false'))

const { createRustAnythingClient } = await import(pathToFileURL(path.join(PKG, 'host', 'mcp-client.js')).href)

const client = createRustAnythingClient({
  cli: process.execPath,
  argv: [FIXTURE],
  log: () => {},
  callTimeoutMs: 15_000,
})

try {
  const info = await client.start()
  check('initialize handshake', info && info.name === 'fake-rust-anything', JSON.stringify(info))
  check('state reports running with a pid', client.state.running && Number.isInteger(client.state.pid), `pid ${client.state.pid}`)

  const tools = await client.listTools()
  check('tools/list returns 17 tools', tools.length === 17, `${tools.length}`)
  check('schemas pass through untouched', tools[0].inputSchema && tools[0].inputSchema.type === 'object' && tools[0].inputSchema.properties.crate)
  check('annotations survive', tools[0].annotations && tools[0].annotations.readOnlyHint === true)

  const ok = await client.callTool('analyze', { root: '.' })
  check('tools/call success', ok.ok === true && /called analyze/.test(ok.content[0].text), ok.content[0].text.slice(0, 60))
  check('structuredContent is kept', ok.structuredContent && ok.structuredContent.name === 'analyze')

  const bad = await client.callTool('record', { crate: 'rust/x' })
  check('tools/call isError is surfaced as ok:false', bad.ok === false && bad.structuredContent.code === 'NO_CRATE', JSON.stringify(bad.structuredContent))

  // The fixture emits notifications/tools/list_changed after the second tools/list; reaching it
  // requires a listener that re-lists, which is exactly what the host half does.
  let listChanged = 0
  const off = client.onListChanged(() => { listChanged += 1 })
  await client.listTools()
  const deadline = Date.now() + 4000
  while (listChanged === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  off()
  check('list_changed notification is delivered', listChanged >= 1, `${listChanged}`)

  const controller = new AbortController()
  const pending = client.callTool('build', {}, { signal: controller.signal })
  controller.abort()
  let cancelled = null
  try {
    await pending
  } catch (error) {
    cancelled = String(error && error.message ? error.message : error)
  }
  check('an aborted call rejects', Boolean(cancelled) && /cancelled/.test(cancelled), cancelled || 'resolved')

  const afterCancel = await client.callTool('map', { repo: '.' })
  check('the client keeps working after a cancellation', afterCancel.ok === true)

  client.stop()
  check('stop() clears running', client.state.running === false)
  let refused = null
  try {
    await client.callTool('analyze', {})
  } catch (error) {
    refused = String(error && error.message ? error.message : error)
  }
  check('calling after stop is refused', Boolean(refused) && /not running|stopped/.test(refused), refused || 'resolved')
} catch (error) {
  fail('mcp client', String(error && error.stack ? error.stack : error))
} finally {
  try { client.stop() } catch { /* already stopped */ }
}

console.log('')
if (failures.length === 0) {
  console.log('clienttest: all checks passed')
  process.exit(0)
}
console.log(`clienttest: ${failures.length} failure(s)`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)