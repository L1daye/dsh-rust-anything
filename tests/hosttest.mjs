// Host-half test: drives apply() through a stub DSH context with a fake `rust-anything mcp`
// (tests/fixtures/fake-mcp-cli.mjs). No DSH running, no rust-anything binary, no network.
//
//   node tests/hosttest.mjs
//
// Covers: the four ra_* tools, the MCP client starting with the plugin and registering
// mcp__rust_anything__<tool> entries with the server's own schemas, the tool surface switching the
// registry without a restart, the rendered output of an MCP tool, a real tool call, isError
// propagation, and the child being stopped when the plugin unloads.

import fs from 'node:fs'
import os from 'node:os'
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return false
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ra-host-'))
const installDir = path.join(tmp, 'plugin-data')
const projectDir = path.join(tmp, 'app')

// A fake project: TypeScript at the root, one bridged crate, a whole-app recording.
fs.mkdirSync(path.join(projectDir, 'rust', 'fuzzy-rs', 'src'), { recursive: true })
fs.mkdirSync(path.join(projectDir, 'rust', 'app-cases'), { recursive: true })
fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"app"}')
fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), '{}')
fs.writeFileSync(path.join(projectDir, 'rust', 'fuzzy-rs', 'rust-anything.json'), JSON.stringify({
  schema: 'rust-anything/bridge@1',
  unit: 'src/fuzzy.ts',
  language: 'typescript',
  kind: 'napi',
  crate_name: 'fuzzy-rs',
  exports: [{ name: 'fuzzyScore' }, { name: 'rank' }],
  js_only: [{ name: 'parse' }],
  batches: [],
}))
fs.writeFileSync(path.join(projectDir, 'rust', 'fuzzy-rs', 'src', 'port.rs'), '// stubs\n')
fs.writeFileSync(path.join(projectDir, 'rust', 'fuzzy-rs', 'cases.jsonl'), '{"fn":"fuzzyScore"}\n{"fn":"rank"}\n{"fn":"rank"}\n')
fs.writeFileSync(path.join(projectDir, 'rust', 'app-cases', 'cli-001.toml'), 'args = ["--help"]\n')
fs.writeFileSync(path.join(projectDir, 'rust', 'app-cases', 'cli-002.toml'), 'args = ["build"]\n')

const host = await import(pathToFileURL(path.join(PKG, 'host', 'index.js')).href)

const sessionWithDir = { id: 'fake-session' }
const fakeWorkingDirectory = { get: (session) => (session === sessionWithDir ? 'C:\\work\\from-session' : null) }
const registry = new Map()
const routes = new Map()
const cleanups = []
const ctx = {
  tools: {
    register: (definition) => {
      if (registry.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  },
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') cleanups.push(disposer)
    return disposer
  },
  inject: (deps, cb) => {
    // The plugin injects `workingDirectory` to learn the Session's directory, and `webServer` to
    // mount its management routes. Both are stubbed so the route layer can be tested without a
    // Harness: every register() lands in `routes`.
    if (!Array.isArray(deps)) return
    if (deps.includes('workingDirectory')) cb({ workingDirectory: fakeWorkingDirectory })
    if (deps.includes('webServer')) {
      cb({
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect: (fn) => fn(),
      })
    }
  },
}

const mcpNames = () => [...registry.keys()].filter((name) => name.startsWith('mcp__rust_anything__'))
const mcpTool = (name) => registry.get(`mcp__rust_anything__${name}`)

try {
  host.apply(ctx, {
    installDir,
    projectDir,
    installSkillOnBoot: false,
    cliPath: process.execPath,
    mcpArgs: [FIXTURE],
  })

  check('five ra_* tools registered', ['ra_status', 'ra_cli', 'ra_install', 'ra_surface', 'ra_bootstrap'].every((name) => registry.has(name)), [...registry.keys()].filter((n) => n.startsWith('ra_')).join(','))

  // No bridge.json yet: the surface is `all`, so every tool the fake lists is registered.
  const up = await waitUntil(() => mcpNames().length === 16, 10_000)
  check('MCP client starts with the plugin and registers 16 tools', up, `${mcpNames().length} registered`)

  const analyze = mcpTool('analyze')
  check('tool name carries the documented prefix', Boolean(analyze) && analyze.name === 'mcp__rust_anything__analyze')
  check('the server schema is passed through', analyze && analyze.parameters && analyze.parameters.type === 'object' && analyze.parameters.properties.crate)
  check('read-only tools say so', analyze && /read-only/.test(analyze.description || ''), analyze && analyze.description)
  check('a long timeout is declared', analyze && analyze.timeoutMs >= 60_000, `${analyze && analyze.timeoutMs}`)

  const rendered = analyze.output.render({}, { ok: true, content: [{ type: 'text', text: 'hello from rust-anything' }] })
  check('render emits the server text', rendered.length === 1 && rendered[0].text === 'hello from rust-anything')

  const called = await analyze.execute({ root: '.' })
  check('calling an MCP tool reaches the server', called.ok === true && /called analyze/.test(called.content[0].text), called.content[0].text.slice(0, 50))

  const failedRender = mcpTool('record').output.render({}, { ok: false, content: [{ type: 'text', text: 'record failed: no crate' }] })
  check('a failed call is rendered with a leading note', failedRender.length === 2 && /failed/.test(failedRender[0].text))

  const status = await registry.get('ra_status').execute({})
  check('ra_status sees the running client', status.mcp.running === true && status.mcp.serverVersion === '9.9.9', JSON.stringify({ running: status.mcp.running, version: status.mcp.serverVersion }))
  check('ra_status counts 16/16 tools', status.mcp.total === 16 && status.mcp.visible === 16, `${status.mcp.visible}/${status.mcp.total}`)
  check('ra_status reads the bridged crate', status.project.crates.length === 1 && status.project.crates[0].cases === 3)
  check('ra_status sees the whole-app recording', status.project.app && status.project.app.cases === 2)
  check('ra_status renders text', /MCP:/.test(registry.get('ra_status').output.render({}, status)[0].text))

  const plan = await registry.get('ra_surface').execute({ surface: 'plan' })
  check('ra_surface plan shrinks the registry to 5', mcpNames().length === 5 && plan.mcp.visible === 5, `${mcpNames().length}`)
  check('plan hides record/build/gate', !mcpTool('record') && !mcpTool('build') && !mcpTool('gate'))
  check('plan keeps analyze/bridge/refresh/profile/map', ['analyze', 'bridge', 'refresh', 'profile', 'map'].every((name) => Boolean(mcpTool(name))))
  check('bridge.json persisted the tier', JSON.parse(fs.readFileSync(path.join(installDir, 'bridge.json'), 'utf8')).allow.length === 5)

  const port = await registry.get('ra_surface').execute({ surface: 'port' })
  check('ra_surface port grows the registry to 11', mcpNames().length === 11 && port.mcp.visible === 11, `${mcpNames().length}`)
  const recordResult = await mcpTool('record').execute({ crate: 'rust/fuzzy-rs' })
  check('isError comes back as ok:false through the registry', recordResult.ok === false && recordResult.structuredContent.code === 'NO_CRATE')

  const off = await registry.get('ra_surface').execute({ surface: 'off' })
  check('ra_surface off removes every MCP tool', mcpNames().length === 0 && off.mcp.visible === 0)
  check('ra_* tools survive "off"', registry.has('ra_status') && registry.has('ra_cli'))

  const readBack = await registry.get('ra_surface').execute({})
  check('ra_surface reads back the surface', readBack.surface === 'off')

  let complained = null
  try {
    await registry.get('ra_surface').execute({ surface: 'everything' })
  } catch (error) {
    complained = String(error && error.message ? error.message : error)
  }
  check('ra_surface rejects an unknown tier', Boolean(complained) && /unknown surface/.test(complained), complained || 'no error raised')

  // ra_bootstrap: with a CLI that is not rust-anything, `doctor --json` fails, so pass ids
  // explicitly — the dry run then describes exactly what a real run would execute.
  const dry = await registry.get('ra_bootstrap').execute({ ids: ['cargo', 'cc', 'agents', 'mcp server'], dryRun: true, mirror: 'official' })
  const dryIds = dry.items.map((item) => `${item.id}:${item.action}`).join(',')
  // The plan describes the machine it runs on, so assert the *rule* rather than one machine's state:
  // an ok check stays untouched, an uninstallable one is skipped, anything else gets a command.
  const plannedActions = Object.fromEntries(dry.items.map((item) => [item.id, item]))
  check('the dry run says so', dry.dryRun === true)
  check('every planned item has a known action', dry.items.every((item) => ['ok', 'install', 'skip', 'unknown'].includes(item.action)), dryIds)
  check('cargo is either ready or planned through rustup-init', (() => {
    const item = plannedActions.cargo
    if (!item) return false
    if (item.action === 'ok') return true
    return item.action === 'install' && /rustup-init/.test(item.command || '')
  })(), `cargo:${plannedActions.cargo && plannedActions.cargo.action}`)
  check('cc is ready, planned, or reported unknown', (() => {
    const item = plannedActions.cc
    if (!item) return false
    if (item.action === 'ok' || item.action === 'unknown') return true
    return item.action === 'install' && /winget|BuildTools/.test(item.command || '')
  })(), `cc:${plannedActions.cc && plannedActions.cc.action}`)

  check('ra_bootstrap never installs agents', dry.items.some((item) => item.id === 'agents' && item.action === 'skip'))
  check('ra_bootstrap dry run touches nothing', !fs.existsSync(path.join(installDir, 'cache')))
  // ---- path handling ---------------------------------------------------------------------
  const base = path.join(tmp, 'app')
  check('a relative path becomes absolute', host.absolutizePath('rust/foo-rs', base) === path.join(base, 'rust', 'foo-rs'))
  check('an absolute path is left alone', host.absolutizePath(path.join(base, 'x'), base) === path.join(base, 'x'))
  check('a URL is never touched', host.absolutizePath('https://example.com/a', base) === 'https://example.com/a')
  check('a bare crate name is kept when nothing exists', host.absolutizePath('nope-rs', base, true) === 'nope-rs')
  check('a crate name under rust/ resolves to the folder', host.absolutizePath('fuzzy-rs', base, true) === path.join(base, 'rust', 'fuzzy-rs'))
  const toolArgs = host.normalizeToolArgs({ root: '.', crate: 'fuzzy-rs', count: 5 }, base)
  check('tool args normalise root', toolArgs.root === base, toolArgs.root)
  check('tool args resolve a crate name that exists under rust/', toolArgs.crate === path.join(base, 'rust', 'fuzzy-rs'), toolArgs.crate)
  const elsewhere = path.join(tmp, 'other-repo')
  const outArgs = host.normalizeToolArgs({ root: elsewhere, unit: 'x.ts', out: 'rust/x-rs' }, base)
  check('a relative out follows the project root, not the session', outArgs.out === path.join(elsewhere, 'rust', 'x-rs'), outArgs.out)
  check('non-path args survive', toolArgs.count === 5)
  const cliArgs = host.normalizeCliArgs(['build', 'rust/fuzzy-rs', '--quiet'], base)
  check('ra_cli rewrites the crate argument', cliArgs[1] === path.join(base, 'rust', 'fuzzy-rs'), cliArgs[1])
  check('ra_cli leaves other subcommands alone', host.normalizeCliArgs(['analyze', '.'], base)[1] === '.')
  check('the session directory wins over process.cwd()', host.resolveBaseDir({}, { agent: { session: sessionWithDir } }) === 'C:\\work\\from-session')
  check('projectDir is the fallback', host.resolveBaseDir({ projectDir: 'C:\\configured' }, {}) === 'C:\\configured')
  // ---- HTTP routes: auth fence, surface switch, cancel -----------------------------------
  const callRoute = (pathname, options = {}) => {
    const handler = routes.get(pathname)
    if (!handler) throw new Error(`route not registered: ${pathname}`)
    const { method = 'GET', headers = {}, body } = options
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body)
      const req = {
        method,
        url: pathname,
        headers,
        on(event, cb) {
          if (event === 'data' && payload) setImmediate(() => cb(Buffer.from(payload)))
          if (event === 'end') setImmediate(() => cb())
          return req
        },
        destroy() {},
      }
      const res = {
        statusCode: 0,
        writeHead(status) { this.statusCode = status },
        end(chunk) {
          let parsed = null
          try { parsed = chunk ? JSON.parse(chunk) : null } catch { parsed = null }
          resolve({ status: this.statusCode, body: parsed })
        },
      }
      Promise.resolve(handler(req, res)).catch(reject)
    })
  }

  check('six routes are registered', routes.size === 6, [...routes.keys()].join(','))

  const loopback = { host: '127.0.0.1:5173' }
  const tokenReply = await callRoute('/rust-anything/api/token', { headers: loopback })
  check('the token route answers on loopback without a bearer', tokenReply.status === 200 && /^[0-9a-f]{64}$/.test(tokenReply.body.token || ''), `status ${tokenReply.status}`)
  const token = tokenReply.body.token
  const auth = { ...loopback, authorization: `Bearer ${token}` }

  check('status without a bearer is 401', (await callRoute('/rust-anything/api/status', { headers: loopback })).status === 401)
  check('status with a wrong bearer is 401', (await callRoute('/rust-anything/api/status', { headers: { ...loopback, authorization: 'Bearer deadbeef' } })).status === 401)
  check('a non-loopback Host is refused', (await callRoute('/rust-anything/api/status', { headers: { host: 'evil.example:80', authorization: `Bearer ${token}` } })).status === 403)

  const statusReply = await callRoute('/rust-anything/api/status', { headers: auth })
  check('status with the bearer is 200', statusReply.status === 200 && statusReply.body.ok === true, `status ${statusReply.status}`)
  check('status reports the configured root', statusReply.body.root === installDir)

  const surfaceGet = await callRoute('/rust-anything/api/surface', { headers: auth })
  check('surface GET carries the live tool counts', surfaceGet.status === 200 && surfaceGet.body.mcpTools && surfaceGet.body.mcpTools.total === 16, JSON.stringify(surfaceGet.body.mcpTools))

  const surfacePost = await callRoute('/rust-anything/api/surface', { method: 'POST', headers: auth, body: { surface: 'plan' } })
  check('surface POST applies the tier', surfacePost.status === 200 && surfacePost.body.surface === 'plan' && mcpNames().length === 5, `${surfacePost.body.surface}, ${mcpNames().length} tools`)

  const badSurface = await callRoute('/rust-anything/api/surface', { method: 'POST', headers: auth, body: { surface: 'everything' } })
  check('surface POST rejects an unknown tier', badSurface.status === 400)

  const cancelReply = await callRoute('/rust-anything/api/bootstrap', { method: 'POST', headers: auth, body: { cancel: true } })
  check('cancel answers 200 even with nothing running', cancelReply.status === 200 && cancelReply.body.cancelled === true, `status ${cancelReply.status}`)

  const boardReply = await callRoute('/rust-anything/api/board', { headers: auth })
  check('the board route answers', boardReply.status === 200)
  // Unloading the plugin must stop the child process it owns.
  const clientState = (await registry.get('ra_status').execute({})).mcp.client
  check('the client reports a pid while running', clientState && Number.isInteger(clientState.pid), JSON.stringify(clientState && clientState.pid))
  for (const dispose of cleanups.splice(0).reverse()) {
    try { dispose() } catch { /* ignore */ }
  }
  await sleep(300)
  check('unload stops the MCP client', mcpNames().length === 0)
} catch (error) {
  fail('host tools', String(error && error.stack ? error.stack : error))
} finally {
  for (const dispose of cleanups.splice(0)) {
    try { dispose() } catch { /* ignore */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* leave it */ }
}

console.log('')
if (failures.length === 0) {
  console.log('hosttest: all checks passed')
  process.exit(0)
}
console.log(`hosttest: ${failures.length} failure(s)`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
