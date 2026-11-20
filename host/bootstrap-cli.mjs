// install-time entry point: `node host/bootstrap-cli.mjs --plan rust [--dry-run] [--root <dir>]`
//
// Called by install.ps1 -Bootstrap <plan> and usable by hand. It reuses host/bootstrap.js, so the
// archive, the page button and this CLI all install exactly the same things in the same order.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { bootstrapStateFile, localStatus, PLANS, planFor, readDoctor, runBootstrap } from './bootstrap.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : true) : null
}
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const root = String(flag('root') || path.join(HOME, '.dsh', 'plugins-data', 'rust-anything'))
const plan = String(flag('plan') || 'rust')
const mirror = String(flag('mirror') || 'auto')
const idsArg = typeof flag('ids') === 'string' ? String(flag('ids')).split(',').map((id) => id.trim()).filter(Boolean) : undefined
const proxy = typeof flag('proxy') === 'string' ? flag('proxy') : null
const dryRun = args.includes('--dry-run')

if (!PLANS[plan] && !args.includes('--ids')) {
  console.error(`unknown plan "${plan}"; use one of ${Object.keys(PLANS).join(', ')}`)
  process.exit(2)
}

function run(command, argv, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, argv, { cwd: options.cwd, env: options.env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error && error.message ? error.message : error), ms: 0 })
      return
    }
    const timer = options.timeoutMs > 0 ? setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, options.timeoutMs) : null
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error && error.message ? error.message : error), ms: Date.now() - started }) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }) })
  })
}

function findCli() {
  const exe = process.platform === 'win32' ? 'rust-anything.exe' : 'rust-anything'
  const explicit = flag('cli')
  if (typeof explicit === 'string' && fs.existsSync(explicit)) return explicit
  const direct = path.join(root, 'bin', exe)
  if (fs.existsSync(direct)) return direct
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch { /* no root yet */ }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, exe)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const cli = findCli()
if (!cli) {
  console.error(`rust-anything was not found under ${root}; install it first (ra_install, or npm i -g rust-anything)`)
  process.exit(3)
}

const doctor = await readDoctor(run, cli)
if (!doctor.ok) {
  console.error(`doctor did not answer with JSON: ${doctor.error}`)
  process.exit(4)
}

const local = await localStatus(run, process.env)
const items = planFor({ plan, ids: idsArg, checks: doctor.checks, local })
console.log(`rust-anything ${cli}`)
console.log(`plan ${plan}: ${items.length} item(s)`)
for (const item of items) {
  console.log(`  - ${item.id}: ${item.action}${item.detail ? ` (${item.detail})` : ''}`)
}
if (dryRun) {
  console.log('\ndry run: nothing changed. Commands a real run would use:')
  const preview = await runBootstrap({ run, cli, root, plan, ids: idsArg, mirror, proxy, dryRun: true })
  for (const item of preview.items) if (item.command) console.log(`  ${item.id}: ${item.command}`)
  process.exit(0)
}

const job = await runBootstrap({
  run,
  cli,
  root,
  plan,
  ids: idsArg,
  mirror,
  proxy,
  log: (line) => console.log(`  ${line}`),
})
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(bootstrapStateFile(root), `${JSON.stringify({ running: false, ...job }, null, 2)}\n`)
console.log('')
console.log(`bootstrap ${job.ok ? 'ok' : 'finished with failures'} in ${Math.round(job.ms / 1000)} s`)
if (job.doctorAfter) {
  console.log(`doctor after: ${job.doctorAfter.ok}/${job.doctorAfter.total} ok${job.doctorAfter.stillMissing.length ? ` — still missing: ${job.doctorAfter.stillMissing.join(', ')}` : ''}`)
}
process.exit(job.ok ? 0 : 1)
