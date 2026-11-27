// Static consistency test: the files a DSH bundle is built from agree with each other.
// Runs anywhere — no DSH, no rust-anything binary, no network.
//
//   node tests/selftest.mjs
//
// Behaviour is covered by tests/clienttest.mjs (the MCP client) and tests/hosttest.mjs (apply()).

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

const failures = []
const pass = (name, detail = '') => console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
  console.log(`  FAIL ${name} — ${detail}`)
}
const check = (name, condition, detail = '') => (condition ? pass(name, detail) : fail(name, detail || 'condition false'))
const read = (file) => fs.readFileSync(path.join(PKG, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

try {
  const pkg = readJson('package.json')
  const plugin = readJson('dsh.plugin.json')

  check('package and plugin version agree', pkg.version === plugin.version, `${pkg.version} / ${plugin.version}`)
  check('package id matches the bundle name', pkg.name === 'dsh-rust-anything' && plugin.id === 'dsh-rust-anything')
  check('the only bundle row is this package', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml')
  check('no peer dependency on a harness package', !pkg.peerDependencies, JSON.stringify(pkg.peerDependencies || {}))
  check('contributes the five host tools', ['ra_status', 'ra_cli', 'ra_install', 'ra_surface', 'ra_bootstrap'].every((name) => plugin.contributes.tools.includes(name)))
  check('declares the MCP server name it registers under', plugin.contributes.mcp.includes('rust_anything'))

  // Every file the manifest promises exists, and every file that exists is promised.
  const declared = new Set(pkg.files.flatMap((pattern) => {
    if (!pattern.includes('*')) return [pattern]
    const dir = path.dirname(pattern)
    const suffix = pattern.slice(pattern.indexOf('*') + 1)
    return fs.readdirSync(path.join(PKG, dir)).filter((name) => name.endsWith(suffix)).map((name) => path.posix.join(dir, name))
  }))
  declared.add('package.json')
  const onDisk = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(PKG, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else onDisk.push(rel)
    }
  }
  walk('')
  // Files that exist in the repository but are not part of the npm payload.
  const repoOnly = new Set(['.gitignore', '.gitattributes'])
  const unpromised = onDisk.filter((rel) => !declared.has(rel) && !rel.startsWith('tests/') && !rel.startsWith('.github/') && !rel.startsWith('.git/') && !rel.startsWith('docs/') && !repoOnly.has(rel) && rel !== 'package.json')
  check('every shipped file is listed in package.files', unpromised.length === 0, unpromised.join(', '))
  for (const rel of ['host/index.js', 'host/mcp-client.js', 'client.js', 'cordis.patch.yml', 'dsh.plugin.json', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'skills/rust-anything/SKILL.md', 'skills/rust-anything/whole-app.md']) {
    check(`ships ${rel}`, fs.existsSync(path.join(PKG, rel)))
  }

  // The patch: exactly one row, ours, with no launcher and no mcp-client package.
  const patch = read('cordis.patch.yml')
  const rows = [...patch.matchAll(/^ {4}- id: (.+)$/gm)].map((match) => match[1].trim())
  check('the patch inserts exactly one row', rows.length === 1 && rows[0] === 'rust-anything-host', rows.join(', '))
  check('the row mounts this package', /^ {6}name: dsh-rust-anything$/m.test(patch))
  const externalClientRow = /name:\s*['"]@deepseek-ai\/dsh-mcp-client['"]/.test(patch)
  check('no row names an external MCP client', !externalClientRow)
  check('no inline -e launcher script', !/^\s*- '-e'$/m.test(patch))
  const hostSource = read('host/index.js')
  check('long calls get a raised timeout by default', /callTimeoutMs/.test(hostSource) && /900_000/.test(hostSource))

  // Host half and client half load.
  const host = await import(pathToFileURL(path.join(PKG, 'host', 'index.js')).href)
  // The engine's MCP reader treats a mistyped field as omitted, so a wrong type has to be caught here
  // or the call silently runs with a default the caller never asked for.
  {
    const tool = {
      name: 'record',
      inputSchema: {
        type: 'object',
        properties: {
          crate: { type: 'string' },
          'port': { type: 'integer', minimum: 1, maximum: 65535 },
          mode: { type: 'string', enum: ['fast', 'full'] },
          run: { type: 'array', items: { type: 'string' } },
        },
        required: ['crate'],
      },
    }
    const accepts = (args) => { try { host.validateToolArgs(tool, args); return true } catch { return false } }
    check('a valid call passes validation', accepts({ crate: 'rust/x', 'port': 8080, mode: 'fast', run: ['node', 'a.js'] }))
    // A missing toolchain is the one failure the model can fix, but only if it is told how; the
    // engine reports a bare "program not found".
    check('a missing cargo gets an install hint', /cargo/i.test(host.environmentHint('running cargo build: program not found')))
    check('the Store python stub is explained', /9009/.test(host.environmentHint('python failed (exit code: 9009)')))
    check('the hint requires a Harness restart', /restart|重启/i.test(host.environmentHint('running node: program not found')))
    check('an unrelated failure gets no hint', host.environmentHint('NO_CRATE: no crate at rust/x') === '')
    check('a missing required argument is rejected', !accepts({}))
    check('a string where an integer belongs is rejected', !accepts({ crate: 'c', 'port': '8080' }))
    check('an out-of-range integer is rejected', !accepts({ crate: 'c', 'port': 70000 }) && !accepts({ crate: 'c', 'port': 0 }))
    check('a value outside the enum is rejected', !accepts({ crate: 'c', mode: 'slow' }))
    check('a mistyped array item is rejected', !accepts({ crate: 'c', run: ['ok', 7] }))
    check('an unknown argument is rejected', !accepts({ crate: 'c', extra: 1 }))
    check('a non-object payload is rejected', !accepts('crate=rust/x'))
  }

  // Upstream tells the agent to fall back to the CLI and to run `rust-anything setup`, which
  // registers other agents; leaving that paragraph in the prompt contradicts the preamble.
  {
    const guide = read('skills/rust-anything/SKILL.md')
    check('the packaged guide still contains the upstream fallback', /If the MCP tools are not available/.test(guide))
    check('sanitizeGuide removes the fallback paragraph', !/If the MCP tools are not available/.test(host.sanitizeGuide(guide)))
    check('sanitizeGuide keeps the rest of the guide', host.sanitizeGuide(guide).length > guide.length - 600 && /Migration to Rust with rust-anything/.test(host.sanitizeGuide(guide)))
  }
  check('host exports apply()', typeof host.apply === 'function')
  check('host exports inject', Array.isArray(host.inject) && host.inject.includes('tools'))
  check('host exports 4 surfaces', host.SURFACES && Object.keys(host.SURFACES).join(',') === 'off,plan,port,all')
  // Tiers come from the server's annotations, not from name lists: a hardcoded list is what kept the
  // tools added after 2.1.0 (go/fuzz/package/enable/disable/report) out of the everyday tiers.
  check('every surface names a mode, never a fixed tool list', ['off', 'plan', 'port', 'all'].every((tier) => !('allow' in host.SURFACES[tier])))
  check('plan is annotation-driven', host.SURFACES.plan.mode === 'plan')
  check('port and all expose every listed tool', host.SURFACES.port.mode === 'all' && host.SURFACES.all.mode === 'all')
  check('read-only is read from annotations', host.isReadOnlyTool({ name: 'analyze', annotations: { readOnlyHint: true } }) && !host.isReadOnlyTool({ name: 'build', annotations: { readOnlyHint: false } }) && !host.isReadOnlyTool({ name: 'x' }))
  check('plan keeps the writing planning steps', ['bridge', 'refresh', 'profile'].every((name) => host.isPlanTool({ name })))
  check('a tool nobody listed is not in plan', !host.isPlanTool({ name: 'go' }))
  // The archive hash identifies the download; the executable inside it is what runs.
  {
    const lock = JSON.parse(read('upstream-lock.json'))
    const pinned = lock.platforms && lock.platforms['win32-x64']
    check('the upstream lock pins a tag', typeof lock.tag === 'string' && /^v\d/.test(lock.tag))
    check('the upstream lock pins executable bytes', Boolean(pinned) && /^[0-9a-f]{64}$/.test(pinned.executableSha256))
    check('an unpinned tag is reported, not rejected', host.verifyExecutable('v0.0.0-unpinned', path.join(PKG, 'package.json')).pinned === false)
  }

  const clientModule = await import(pathToFileURL(path.join(PKG, 'host', 'mcp-client.js')).href)
  check('mcp-client exports a factory', typeof clientModule.createRustAnythingClient === 'function')

  // doctor's Windows false alarms are corrected before the page or ra_status sees them.
  const decorated = host.decorateDoctorChecks([
    { name: 'cc', status: 'missing', required: false, detail: '`cc` not found' },
    { name: 'cargo', status: 'missing', required: true, detail: '`cargo` not found' },
    { name: 'agents', status: 'missing', required: false, detail: 'no coding agent' },
    { name: 'node', status: 'outdated', required: false, detail: 'v20.14.0' },
  ], { cc: 'ok', ccPath: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community', cargo: 'path-only' })
  const byName = Object.fromEntries(decorated.map((entry) => [entry.name, entry]))
  check('an installed MSVC turns doctor\'s cc into ok', byName.cc.status === 'ok' && /vswhere|MSVC/.test(byName.cc.note), byName.cc.note)
  check('cc keeps the raw probe result for the curious', byName.cc.doctorStatus === 'missing')
  check('cargo off PATH suggests a PATH fix, not an install', byName.cargo.suggested === 'fixpath')
  check('agents can never be installed from the card', byName.agents.installable === false && byName.agents.suggested === 'skip')
  check('a real gap keeps its install button', byName.node.suggested === 'install' && byName.node.installable === true)
  check('an ok check never offers a button', host.decorateDoctorChecks([{ name: 'node', status: 'ok' }], {}).every((entry) => entry.suggested === 'skip'))
  const clientResult = spawnSync(process.execPath, ['--check', path.join(PKG, 'client.js')], { encoding: 'utf8' })
  check('client.js parses', clientResult.status === 0, (clientResult.stderr || '').split('\n')[0])
  const client = read('client.js')
  // Every string the page asks for must exist in both languages — a missing key renders `undefined`
  // inside a card, which is exactly the kind of bug a screenshot review would catch too late.
  const usedKeys = new Set([...client.matchAll(/\bs\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))
  const zhKeys = new Set([...read('client.js').matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*): '[^']*',?$/gm)].map((match) => match[1]))
  const missingKeys = [...usedKeys].filter((key) => !zhKeys.has(key))
  check('every s.<key> used by the page is defined', missingKeys.length === 0, missingKeys.join(', '))
  check('the card has a per-row state dot', /function toneOf/.test(client) && client.includes('function EnvRow'))
  check('the page sums ready vs to-install', client.includes('envReadyCount') && client.includes('envTodoCount'))
  check('the status card never prints doctor fix commands', !client.includes('check.fix ?'))

  check('client registers the sidebar panel', client.includes("'sidebar.panellist'"))
  check('client registers the page', client.includes("slots.register({ name: 'main'"))
  check('client registers the composer chip', client.includes("'conversation.input.left'"))
  check('client offers the same four tiers', /const TIERS = \['off', 'plan', 'port', 'all'\]/.test(client))
  check('client talks to the five routes', ['/token', '/status', '/board', '/surface', '/install', '/bootstrap'].every((route) => client.includes(`/rust-anything/api${route}`)))
  check('client has the environment card', client.includes('function EnvCard'))
  check('the card labels a PATH fix differently', client.includes('envFixPath'))
  check('the card can render a skip', client.includes('envSkip'))
  check('the page scrolls in a small window', /\.dsh-ra-page \{[^}]*overflow-y: auto/.test(client))
  check('the env list scrolls on its own', /\.dsh-ra-envlist \{[^}]*overflow-y: auto/.test(client))
  check('status is a coloured dot, not a word', client.includes('dsh-ra-dot is-') && client.includes('.dsh-ra-dot.is-ok'))
  check('a killed job is reported as stale', client.includes('envStale') && read('host/index.js').includes('stale: stored.running === true'))

  // Bootstrap: every check doctor can emit has an entry, and the hard blockers are in every plan.
  // rust-anything 2.1 added Kotlin and Android; every id doctor can emit needs a recipe here.
  const boot = await import(pathToFileURL(path.join(PKG, 'host', 'bootstrap.js')).href)
  const doctorIds = ['cargo', 'node', 'python3', 'cc', 'go', 'ruby', 'java', 'javac', 'php', 'dotnet', 'wasm-bindgen', 'wasm32-unknown-unknown', 'kotlinc', 'Android NDK', 'Android Rust targets', 'Android adb', 'mcp server', 'agents']
  const missing = doctorIds.filter((id) => !boot.CHECKS[id])
  check('every doctor check has an install recipe', missing.length === 0, missing.join(', '))
  // adb ships in platform-tools, not in the NDK, and rust-anything 5.x checks for it by name.
  check('adb comes from platform-tools and lands on PATH', (() => {
    const adb = boot.CHECKS['Android adb']
    if (!adb || !adb.direct) return false
    return /platform-tools-latest-windows\.zip$/.test(adb.direct.url) && adb.direct.dest === 'platform-tools'
      && adb.direct.flatten === true && adb.direct.path.includes('{root:dest}')
  })())
  check('the android plan installs adb with the NDK', boot.PLANS.android.includes('Android adb') && boot.PLANS.android.includes('Android NDK'))
  check('agents and the MCP server are never installed', boot.CHECKS.agents.skip === 'agent' && boot.CHECKS['mcp server'].skip === 'self')
  check('cargo comes from the official rustup', /win\.rustup\.rs/.test(JSON.stringify(boot.CHECKS.cargo)))
  check('a CN mirror is available for rustup', /tuna\.tsinghua\.edu\.cn/.test(boot.MIRRORS.cn.RUSTUP_DIST_SERVER) && Boolean(boot.MIRRORS.cn.RUSTUP_UPDATE_ROOT))
  check('rsproxy is kept as an alternative', /rsproxy/.test(boot.MIRRORS.rsproxy.RUSTUP_DIST_SERVER))
  check('local detection exists for the two Windows traps', typeof boot.localStatus === 'function' && typeof boot.ensureUserPath === 'function')
  check('the mirror can be probed instead of guessed', typeof boot.probeMirror === 'function' && typeof boot.resolveMirror === 'function')
  const sum = boot.summarize([{ name: 'cc', status: 'missing' }, { name: 'agents', status: 'missing' }, { name: 'node', status: 'ok' }, { name: 'php', status: 'missing' }], { cc: 'ok' })
  check('the summary agrees with the rows', sum.ok === 2 && sum.stillMissing.join(',') === 'php (missing)' && sum.skipped.some((line) => line.startsWith('cc')) && sum.skipped.some((line) => line.startsWith('agents')), JSON.stringify(sum))
  check('an off-PATH cargo becomes a PATH fix, not a reinstall', boot.planFor({ plan: 'rust', checks: [{ name: 'cargo', status: 'missing' }], local: { cargo: 'path-only' } }).some((item) => item.id === 'cargo' && item.action === 'fixpath'))
  check('an installed MSVC satisfies the cc check', boot.planFor({ plan: 'rust', checks: [{ name: 'cc', status: 'missing' }], local: { cc: 'ok', ccPath: 'C:\\VS' } }).some((item) => item.id === 'cc' && item.action === 'ok'))
  check('cc installs the MSVC build tools', boot.CHECKS.cc.winget === 'Microsoft.VisualStudio.2022.BuildTools')
  check('every plan starts with cargo and cc', Object.entries(boot.PLANS).every(([, ids]) => ids.includes('cargo') && ids.includes('cc')))
  check('the wasm plan adds a target and bindgen', boot.PLANS.wasm.includes('wasm32-unknown-unknown') && boot.PLANS.wasm.includes('wasm-bindgen'))
  check('dry runs describe commands without running them', /rustup-init/.test(boot.describeItem({ id: 'cargo', action: 'install' })) && /winget install/.test(boot.describeItem({ id: 'cc', action: 'install' })))
  const planned = boot.planFor({ plan: 'rust', checks: [{ name: 'cargo', status: 'missing', required: true }, { name: 'cc', status: 'missing', required: false }] })
  check('planFor puts rustup before the linker', planned.length === 2 && planned[0].id === 'cargo' && planned[1].id === 'cc')
  check('planFor skips checks doctor calls ok', boot.planFor({ plan: 'rust', checks: [{ name: 'cargo', status: 'ok' }, { name: 'cc', status: 'ok' }] }).every((item) => item.action === 'ok'))
  // Newer CLI builds list the agent targets one by one instead of a single `agents` row.
  check('agents are never installed', ['agents', 'mcp server'].every((name) => boot.neverInstalled(name)))
  check('split agent targets are never installed', ['Claude Code mcp', 'Claude Code skill', 'Gemini CLI mcp', 'Codex skill'].every((name) => boot.neverInstalled(name)))
  check('a real toolchain is installable', !boot.neverInstalled('cargo') && !boot.neverInstalled('Android NDK'))
  check('bootstrap-cli ships', fs.existsSync(path.join(PKG, 'host', 'bootstrap-cli.mjs')))
} catch (error) {
  fail('static checks', String(error && error.stack ? error.stack : error))
}

console.log('')
if (failures.length === 0) {
  console.log('selftest: all checks passed')
  process.exit(0)
}
console.log(`selftest: ${failures.length} failure(s)`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)