// dsh-rust-anything — Host half.
//
// One bundle row, no peer dependency. This file owns:
//   - four tools: ra_status / ra_cli / ra_install / ra_surface
//   - the MCP client (host/mcp-client.js) for `rust-anything mcp`, whose 16 tools it registers as
//     mcp__rust_anything__<tool>, filtered by the tool surface in <root>/bridge.json
//   - the workflow skill, installed into <DSH_HOME>/skills/rust-anything/
//   - the authenticated management routes the Web page reads:
//       GET  /rust-anything/api/token     bootstrap token (loopback + connection admission only)
//       GET  /rust-anything/api/status    install / project / bridge report
//       GET  /rust-anything/api/board     `rust-anything map --json` for the current folder
//       GET  /rust-anything/api/surface   current surface + visible/total
//       POST /rust-anything/api/surface   { surface } | { enabled, allow }
//       POST /rust-anything/api/install   { version?, force? } — download, verify, install, restart

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRustAnythingClient } from './mcp-client.js'
import { createHttpAuth, guarded, readJsonBody, rejectRequest, sendJson } from './http-util.js'
import { bootstrapStateFile, CHECKS, localStatus, neverInstalled, PLANS, planFor, readDoctor, refreshMachineEnv, refreshPath, runBootstrap } from './bootstrap.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const SKILL_SRC = path.join(PACKAGE_DIR, 'skills', 'rust-anything')

const IS_WINDOWS = process.platform === 'win32'
const EXE_NAME = IS_WINDOWS ? 'rust-anything.exe' : 'rust-anything'
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()

// The harness itself honours DSH_HOME (portable installs, several homes on one machine); a plugin
// that hardcodes ~/.dsh writes into the wrong home the moment that variable is set.
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(HOME, '.dsh')

const DEFAULT_ROOT = path.join(DSH_HOME, 'plugins-data', 'rust-anything')
const SKILL_ROOT = path.join(DSH_HOME, 'skills', 'rust-anything')

const REPO = 'erkamyaman/rust-anything'
const SERVER_NAME = 'rust_anything'
const TOOL_PREFIX = 'mcp__rust_anything__'
const MAX_CAPTURE = 200_000

// The 16 MCP tools, grouped into the surfaces the chip offers. `all` is the server's own list;
// `port` is every unit-level step, `plan` only what plans (analyze/bridge/refresh/profile/map),
// so a planning turn does not carry record/build/gate/app_* schemas it cannot use. There is no
// separate whole-app tier: the five app_* tools are the last five of the sixteen, so a tier that
// added them would equal `all`.
// Tiers are predicates over the server's own `annotations`, not name lists. A tool the CLI adds
// later lands in the right tier without editing this file; a hardcoded list is exactly how the six
// tools added after 2.1.0 (`go`, `fuzz`, `package`, `enable`, `disable`, `report`) stayed invisible
// in both everyday tiers.
export const SURFACES = {
  off: { enabled: false },
  plan: { enabled: true, preset: 'plan', mode: 'plan' },
  // `port` and `all` expose every tool the server lists; they differ only in the name they report.
  port: { enabled: true, preset: 'port', mode: 'all' },
  all: { enabled: true, preset: 'all', mode: 'all' },
}

const SURFACE_ORDER = ['off', 'plan', 'port', 'all']

// Planning steps that write but still belong to the `plan` tier: `bridge` writes bindings, `refresh`
// rewrites them, `profile` writes a profile. Every other writing tool is `port`.
const PLAN_STEPS = ['bridge', 'refresh', 'profile']

// A bridge.json written by an older build carries the preset as a name list. Those names are a
// snapshot of the preset, not a user choice, so they are migrated instead of honoured — otherwise
// the stale list keeps hiding new tools no matter what SURFACES says.
const LEGACY_ALLOW = {
  plan: ['analyze', 'bridge', 'refresh', 'profile', 'map'],
  port: ['analyze', 'bridge', 'refresh', 'profile', 'map', 'record', 'build', 'diff', 'bench', 'shadow', 'gate'],
}

/** A tool the server marks read-only; the `plan` tier adds these on top of the planning steps. */
export function isReadOnlyTool(tool) {
  return Boolean(tool && tool.annotations && tool.annotations.readOnlyHint === true)
}

/** Every tool the `plan` tier shows: the read-only ones plus the three planning steps. */
export function isPlanTool(tool) {
  if (!tool || typeof tool.name !== 'string') return false
  return isReadOnlyTool(tool) || PLAN_STEPS.includes(tool.name)
}

function existsFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function versionedFirst(names) {
  const rank = (name) => (/^\d+\.\d+\.\d+/.test(name) ? 0 : 1)
  return names.slice().sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }))
}

export function installRoot(config = {}) {
  return typeof config.installDir === 'string' && config.installDir.trim()
    ? path.resolve(config.installDir.trim())
    : DEFAULT_ROOT
}

const statePaths = (config) => {
  const root = installRoot(config)
  return {
    root,
    bridgeFile: path.join(root, 'bridge.json'),
    tokenFile: path.join(root, 'http.token'),
    installFile: path.join(root, 'install.json'),
  }
}

// PATH lookups were ~30 ms each and the status report asks twice; cache them briefly.
const whichCache = new Map()
const WHICH_TTL_MS = 60_000

function which(name) {
  const cached = whichCache.get(name)
  if (cached && Date.now() - cached.at < WHICH_TTL_MS) return cached.value
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  let found = null
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (!existsFile(candidate)) continue
      found = candidate
      break
    }
    if (found) break
  }
  whichCache.set(name, { at: Date.now(), value: found })
  return found
}

/** Every place a rust-anything binary can legitimately live, most specific first. */
function resolveCli(config = {}) {
  const root = installRoot(config)
  const candidates = []
  const push = (cli, source) => {
    if (typeof cli === 'string' && cli.trim() && existsFile(cli.trim())) candidates.push({ cli: path.resolve(cli.trim()), source })
  }
  push(config.cliPath, 'config')
  push(process.env.RUST_ANYTHING_CLI, 'env')
  push(path.join(root, 'bin', EXE_NAME), 'plugin-data')
  for (const dir of versionedFirst(listDirs(root))) push(path.join(root, dir, EXE_NAME), 'plugin-data')
  push(which('rust-anything'), 'PATH')
  push(path.join(HOME, '.cargo', 'bin', EXE_NAME), 'cargo')
  push(path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', EXE_NAME), 'npm')
  const chosen = candidates[0] || null
  return { cli: chosen ? chosen.cli : null, source: chosen ? chosen.source : null, root }
}

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, signal, env, shell } = options
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        env: env || process.env,
        shell: shell === true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message || error), timedOut: false, error: String(error?.message || error), ms: 0 })
      return
    }
    const killHard = () => {
      if (!child) return
      try { if (!child.killed) child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGTERM') } catch { /* already gone */ } }, 150).unref?.()
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 1200).unref?.()
      setTimeout(() => finish(null, 'killed after timeout'), 2500).unref?.()
    }
    const onAbort = () => killHard()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killHard() }, timeoutMs)
      : null
    const finish = (code, errorMessage) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        code: code ?? (timedOut ? null : 0),
        stdout: stdout.slice(0, MAX_CAPTURE),
        stderr: stderr.slice(0, MAX_CAPTURE),
        timedOut,
        ms: Date.now() - started,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(null, String(error?.message || error)))
    child.on('close', (code) => finish(code))
  })
}

// ---------------------------------------------------------------------------------------------
// Probes. `--version` and `doctor --json` spawn processes; the page polls, so cache both.
// ---------------------------------------------------------------------------------------------
const VERSION_TTL_MS = 5 * 60_000
const DOCTOR_TTL_MS = 3 * 60_000
const probeCache = { cli: null, version: null, versionAt: 0, doctor: null, doctorAt: 0 }

// The harness process's PATH is frozen at boot. Every toolchain installed afterwards is invisible to
// it — and doctor is a child of this process, so it kept reporting "cargo/node/python3 missing" for
// things that were installed minutes ago. Rebuild the PATH from the registry (cached for a minute)
// before probing or reconciling anything.
let freshEnvCache = { at: 0, value: null }
async function freshEnv() {
  if (freshEnvCache.value && Date.now() - freshEnvCache.at < 60_000) return freshEnvCache.value
  const withPath = await refreshPath(run, process.env)
  // doctor reads these; the process env is frozen at boot
  const value = await refreshMachineEnv(run, withPath, ['ANDROID_NDK_HOME', 'ANDROID_HOME', 'JAVA_HOME'])
  freshEnvCache = { at: Date.now(), value }
  return value
}

async function versionOf(resolved, refresh = false) {
  if (!resolved.cli) return null
  if (probeCache.cli !== resolved.cli) {
    probeCache.cli = resolved.cli
    probeCache.version = null
    probeCache.versionAt = 0
    probeCache.doctor = null
    probeCache.doctorAt = 0
  }
  if (!refresh && probeCache.version && Date.now() - probeCache.versionAt < VERSION_TTL_MS) return probeCache.version
  const result = await run(resolved.cli, ['--version'], { timeoutMs: 20_000, env: await freshEnv() })
  const text = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null
  probeCache.version = text
  probeCache.versionAt = Date.now()
  return text
}

async function doctorOf(resolved, refresh = false) {
  if (!resolved.cli) return null
  if (!refresh && probeCache.doctor && Date.now() - probeCache.doctorAt < DOCTOR_TTL_MS) return probeCache.doctor
  const result = await run(resolved.cli, ['doctor', '--json'], { timeoutMs: 90_000, env: await freshEnv() })
  let report = null
  try {
    const parsed = JSON.parse(result.stdout)
    if (parsed && Array.isArray(parsed.checks)) {
      report = {
        ok: parsed.checks.every((check) => check.status !== 'missing' || !check.required),
        checks: parsed.checks.map((check) => ({
          name: String(check.name || '?'),
          status: String(check.status || '?'),
          required: Boolean(check.required),
          detail: String(check.detail || '').slice(0, 400),
          fix: check.fix ? String(check.fix).slice(0, 400) : null,
        })),
      }
    }
  } catch { /* doctor --json did not answer with JSON */ }
  if (!report) report = { ok: false, error: `\`doctor --json\` exited ${result.code}`, stderr: (result.stderr || '').trim().slice(0, 600) }
  probeCache.doctor = report
  probeCache.doctorAt = Date.now()
  return report
}

// ---------------------------------------------------------------------------------------------
// Project report: what `analyze` would call a unit, and what is already ported.
// ---------------------------------------------------------------------------------------------
const LANG_MARKERS = [
  ['package.json', 'typescript'],
  ['tsconfig.json', 'typescript'],
  ['pyproject.toml', 'python'],
  ['setup.py', 'python'],
  ['requirements.txt', 'python'],
  ['go.mod', 'go'],
  ['Gemfile', 'ruby'],
  ['pom.xml', 'java'],
  ['composer.json', 'php'],
  ['Cargo.toml', 'rust'],
]

function readJson(file) {
  try {
    // Strip a UTF-8 BOM: Windows PowerShell's `Set-Content -Encoding utf8` adds one, and
    // JSON.parse throws on it. Files written by install.ps1 or by an editor must not take the
    // plugin down.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (!text) return 0
    let lines = 0
    for (const line of text.split('\n')) if (line.trim()) lines += 1
    return lines
  } catch {
    return null
  }
}

function crateReport(dir) {
  const crates = []
  const rustDir = path.join(dir, 'rust')
  for (const name of listDirs(rustDir)) {
    const crateDir = path.join(rustDir, name)
    const manifest = readJson(path.join(crateDir, 'rust-anything.json'))
    if (!manifest) continue
    crates.push({
      crate: name,
      unit: manifest.unit || null,
      language: manifest.language || null,
      kind: manifest.kind || null,
      exports: Array.isArray(manifest.exports) ? manifest.exports.length : 0,
      kept: Array.isArray(manifest.js_only) ? manifest.js_only.length : 0,
      batches: Array.isArray(manifest.batches) ? manifest.batches.length : 0,
      cases: countLines(path.join(crateDir, 'cases.jsonl')),
      portWritable: existsFile(path.join(crateDir, 'src', 'port.rs')),
      dir: crateDir,
    })
  }
  return { rustDir: fs.existsSync(rustDir) ? rustDir : null, crates }
}

function projectReport(dir) {
  const root = path.resolve(dir || process.cwd())
  const languages = []
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'rust' || entry.name === '.git') continue
      for (const [marker, lang] of LANG_MARKERS) {
        if (entry.name === marker && !languages.includes(lang)) languages.push(lang)
      }
      if (entry.name.endsWith('.csproj') || entry.name.endsWith('.sln')) {
        if (!languages.includes('csharp')) languages.push('csharp')
      }
    }
  } catch { /* not a directory */ }
  const { rustDir, crates } = crateReport(root)
  const report = {
    root,
    languages: languages.filter((lang) => lang !== 'rust'),
    isRustProject: languages.includes('rust'),
    rustDir,
    crates,
    app: null,
    portMap: null,
  }
  const appCases = path.join(root, 'rust', 'app-cases')
  if (fs.existsSync(appCases)) {
    let cases = 0
    try {
      cases = fs.readdirSync(appCases).filter((name) => name.endsWith('.toml')).length
    } catch { /* unreadable */ }
    report.app = {
      dir: appCases,
      cases,
      frontDoor: existsFile(path.join(root, 'rust', 'app', 'Cargo.toml')),
      replayReport: existsFile(path.join(appCases, 'replay-report.md')) ? path.join(appCases, 'replay-report.md') : null,
    }
  }
  const portMap = path.join(root, 'rust', 'PORT_MAP.md')
  if (existsFile(portMap)) {
    try {
      report.portMap = { file: portMap, mtime: fs.statSync(portMap).mtime.toISOString() }
    } catch { /* ignore */ }
  }
  return report
}

// ---------------------------------------------------------------------------------------------
// Board: `rust-anything map --json` is read-only and cheap next to record/build, so the page can
// ask for it on mount. Cached per folder for a few seconds.
// ---------------------------------------------------------------------------------------------
const boardCache = new Map()
const BOARD_TTL_MS = 15_000

async function boardReport(config, dir) {
  const root = path.resolve(dir || config.projectDir || process.cwd())
  const cached = boardCache.get(root)
  if (cached && Date.now() - cached.at < BOARD_TTL_MS) return cached.value
  const resolved = resolveCli(config)
  if (!resolved.cli) {
    const value = { ok: false, error: 'rust-anything is not installed yet; run ra_install', root }
    boardCache.set(root, { at: Date.now(), value })
    return value
  }
  const asJson = await run(resolved.cli, ['map', root, '--json'], { timeoutMs: 90_000, cwd: root })
  let value
  if (asJson.code === 0) {
    try {
      value = { ok: true, root, json: JSON.parse(asJson.stdout), ms: asJson.ms }
    } catch {
      value = { ok: false, root, error: '`map --json` did not return JSON', raw: asJson.stdout.slice(0, 4000) }
    }
  } else {
    const asText = await run(resolved.cli, ['map', root], { timeoutMs: 90_000, cwd: root })
    value = {
      ok: asText.code === 0,
      root,
      text: (asText.stdout || asText.stderr || '').slice(0, 20_000),
      error: asText.code === 0 ? null : `\`map\` exited ${asText.code}`,
    }
  }
  boardCache.set(root, { at: Date.now(), value })
  return value
}

// ---------------------------------------------------------------------------------------------
// Surface: bridge.json is the single switch, read by this host half before registering MCP tools.
// ---------------------------------------------------------------------------------------------
/** The preset whose old hardcoded name list is exactly `allow`, else null. */
function legacyPresetOf(allow) {
  const key = allow.slice().sort().join(',')
  for (const [name, names] of Object.entries(LEGACY_ALLOW)) {
    if (names.slice().sort().join(',') === key) return name
  }
  return null
}

function readSurface(config) {
  const { bridgeFile } = statePaths(config)
  const parsed = readJson(bridgeFile)
  const enabled = !(parsed && parsed.enabled === false)
  let allow = parsed && Array.isArray(parsed.allow) ? parsed.allow.filter((entry) => typeof entry === 'string') : []
  let preset = parsed && typeof parsed.preset === 'string' && SURFACES[parsed.preset] && parsed.preset !== 'off'
    ? parsed.preset
    : null
  if (!preset && allow.length) {
    const legacy = legacyPresetOf(allow)
    // Migrated: the stored list was a preset snapshot, so the tier decides from now on.
    if (legacy) {
      preset = legacy
      allow = []
    }
  }
  if (!preset && allow.length === 0) preset = 'all'
  const mode = allow.length ? 'allow' : (preset ? SURFACES[preset].mode : 'all')
  const surface = !enabled ? 'off' : allow.length ? 'custom' : preset
  return { surface, enabled, allow, preset: preset || 'all', mode }
}

function writeSurface(config, patch) {
  const { root, bridgeFile } = statePaths(config)
  const next = { enabled: patch.enabled !== false }
  if (Array.isArray(patch.allow)) next.allow = patch.allow
  else if (typeof patch.preset === 'string' && SURFACES[patch.preset] && patch.preset !== 'off') next.preset = patch.preset
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(bridgeFile, `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  return readSurface(config)
}

function compileAllow(allow) {
  return allow.map((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp('^' + escaped + '$', 'i')
  })
}

// The predicate takes the whole tool, not its name: tier membership comes from the server's own
// `annotations`, so it cannot go stale when the server adds tools.
function allowedNames(surface) {
  if (!surface.enabled) return () => false
  if (surface.mode === 'allow') {
    const matchers = compileAllow(surface.allow)
    if (matchers.length) return (tool) => matchers.some((matcher) => matcher.test(tool.name))
    return () => true
  }
  if (surface.mode === 'plan') return (tool) => isPlanTool(tool)
  return () => true
}

/** One line describing what a tier exposes, shared by the tool output, the report and the page. */
function surfaceScope(surface) {
  if (!surface.enabled) return 'no tools'
  if (surface.mode === 'allow') return surface.allow.length ? surface.allow.join(', ') : 'every tool'
  if (surface.mode === 'plan') return 'read-only tools + bridge/refresh/profile'
  return 'every tool'
}

// ---------------------------------------------------------------------------------------------
// Skill: rust-anything's workflow (SKILL.md + whole-app.md) is where its method actually lives.
// ---------------------------------------------------------------------------------------------
// The upstream skill tells the agent to run `rust-anything setup` when the tools are missing; that
// command registers Claude Code, Codex, Cursor, Gemini CLI and OpenCode, none of which is this
// Harness. The preamble is composed on top of the verbatim upstream text (and rewritten when
// either side changes), so the method stays upstream's and the dsh-specific bits stay ours.
const SKILL_PREAMBLE = `<!-- dsh-rust-anything: this copy is installed and kept in sync by the DSH plugin. In DeepSeek
Harness the tools appear as mcp__rust_anything__*; if they are missing or the CLI is absent, call
ra_install (official release, SHA256-verified) and ra_status, and narrow the tool surface with
ra_surface. Do not run \`rust-anything setup\` here: it registers Claude Code, Codex, Cursor,
Gemini CLI and OpenCode, not this Harness. -->

`

function composeSkill(name, source) {
  if (name !== 'SKILL.md') return source
  return `${SKILL_PREAMBLE}${source}`
}

/**
 * Split the packaged SKILL.md into its front-matter description and its body. A runtime-registered
 * skill carries the description as a field, so the YAML header is dropped from the content.
 */
export function parseSkillSource(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { description: '', body: source }
  const description = /(?:^|\r?\n)description:\s*([^\r\n]+)/.exec(match[1])
  return { description: description ? description[1].trim() : '', body: source.slice(match[0].length) }
}

// Filled by registerSkill so ra_status and the page can report the live registration, not just the
// copy on disk (which goes stale the moment the plugin is upgraded).
let skillRegistration = { ok: false, error: 'not attempted' }

/**
 * Register the workflow as a runtime skill on the Harness itself.
 *
 * Writing the files under <DSH_HOME>/skills was the only path, which left a copy that ages against
 * the plugin version, survives uninstall and competes with a marketplace-installed skill of the same
 * name. A runtime registration is owned by the plugin's fiber: it is the version in the package and
 * it disappears with the plugin. The file copy stays for consumers that read the directory.
 */
export function registerSkill(ctx, report = []) {
  try {
    const file = path.join(SKILL_SRC, 'SKILL.md')
    if (!fs.existsSync(file)) {
      report.push('skill sources are missing from the package')
      skillRegistration = { ok: false, error: 'sources missing' }
      return { ok: false, report }
    }
    if (!ctx || !ctx.skills || typeof ctx.skills.register !== 'function') {
      report.push('this Harness exposes no skills service; only the filesystem copy is available')
      skillRegistration = { ok: false, error: 'no skills service' }
      return { ok: false, report }
    }
    const { description, body } = parseSkillSource(fs.readFileSync(file, 'utf8'))
    ctx.skills.register({
      name: 'rust-anything',
      description: description || 'Port code to Rust one unit at a time with the rust-anything tools.',
      provider: 'dsh-rust-anything',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_SRC.split(path.sep).join('/') },
      content: `${SKILL_PREAMBLE}${body}`,
    })
    report.push('registered the rust-anything skill on the Harness')
    skillRegistration = { ok: true, error: null }
    return { ok: true, report }
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    report.push(`cannot register the skill: ${message}`)
    skillRegistration = { ok: false, error: message }
    return { ok: false, report }
  }
}

function installSkill(report = []) {
  try {
    if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) {
      report.push('skill sources are missing from the package')
      return { ok: false, dir: SKILL_ROOT, report }
    }
    fs.mkdirSync(SKILL_ROOT, { recursive: true })
    for (const name of ['SKILL.md', 'whole-app.md']) {
      const from = path.join(SKILL_SRC, name)
      const to = path.join(SKILL_ROOT, name)
      if (!fs.existsSync(from)) continue
      const wanted = composeSkill(name, fs.readFileSync(from, 'utf8'))
      if (existsFile(to) && fs.readFileSync(to, 'utf8') === wanted) continue
      if (existsFile(to)) {
        fs.writeFileSync(`${to}.bak`, fs.readFileSync(to))
        report.push(`kept the previous ${name} as ${name}.bak`)
      }
      fs.writeFileSync(to, wanted)
      report.push(`wrote ${to}`)
    }
    return { ok: true, dir: SKILL_ROOT, report }
  } catch (error) {
    report.push(`cannot write the skill: ${String(error?.message || error)}`)
    return { ok: false, dir: SKILL_ROOT, report }
  }
}

// ---------------------------------------------------------------------------------------------
// Installer: the official release asset for this platform, SHA256-verified, then cargo as the
// fallback. The caller restarts the MCP client so the new binary is the one serving tools.
// ---------------------------------------------------------------------------------------------
function assetForPlatform() {
  const arch = process.arch
  if (process.platform === 'win32') {
    if (arch !== 'x64') return null
    return { name: 'rust-anything-{v}-x86_64-pc-windows-msvc.zip' }
  }
  if (process.platform === 'darwin') {
    return arch === 'arm64'
      ? { name: 'rust-anything-{v}-aarch64-apple-darwin.tar.gz' }
      : { name: 'rust-anything-{v}-x86_64-apple-darwin.tar.gz' }
  }
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? { name: 'rust-anything-{v}-aarch64-unknown-linux-gnu.tar.gz' }
      : { name: 'rust-anything-{v}-x86_64-unknown-linux-gnu.tar.gz' }
  }
  return null
}

async function httpJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsh-rust-anything', accept: 'application/vnd.github+json' },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

async function httpText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-rust-anything' }, redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.text()
}

async function httpBinary(url, to) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-rust-anything' }, redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(to, buffer)
  return buffer.length
}

function findBinary(dir) {
  const queue = [dir]
  while (queue.length > 0) {
    const current = queue.shift()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name === EXE_NAME || entry.name === 'rust-anything.exe' || entry.name === 'rust-anything') return full
    }
  }
  return null
}

function findTar() {
  return which('tar') || (IS_WINDOWS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null)
}

/**
 * @param {object} config plugin settings
 * @param {{version?:string, force?:boolean, signal?:AbortSignal, log?:(line:string)=>void}} options
 */
async function installCli(config, options = {}) {
  const log = options.log || (() => {})
  const paths = statePaths(config)
  fs.mkdirSync(paths.root, { recursive: true })
  const version = options.version && String(options.version).trim() ? String(options.version).trim() : 'latest'
  const asset = assetForPlatform()
  const report = []

  if (typeof fetch !== 'function') report.push('this Node build has no fetch; falling back to cargo')
  else if (!asset) report.push(`no prebuilt rust-anything release for ${process.platform}/${process.arch}; falling back to cargo`)

  if (typeof fetch === 'function' && asset) {
    try {
      const releasePath = version === 'latest' ? 'latest' : `tags/${version}`
      const release = await httpJson(`https://api.github.com/repos/${REPO}/releases/${releasePath}`)
      const tag = String(release.tag_name || version)
      const fileName = asset.name.replace('{v}', tag)
      const wanted = (release.assets || []).find((entry) => entry.name === fileName)
      if (!wanted) throw new Error(`release ${tag} has no asset ${fileName}`)
      const target = path.join(paths.root, tag)
      const binary = path.join(target, EXE_NAME)
      if (existsFile(binary) && !options.force) {
        report.push(`rust-anything ${tag} is already in ${target} (pass force to re-download)`)
      } else {
        const sumsUrl = `https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS`
        const tmp = path.join(os.tmpdir(), `rust-anything-${Date.now()}-${fileName}`)
        log(`downloading ${fileName}`)
        const bytes = await httpBinary(wanted.browser_download_url, tmp)
        const sums = await httpText(sumsUrl)
        const expected = sums
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .find((parts) => parts[1] === fileName)
        if (!expected) throw new Error(`SHA256SUMS has no line for ${fileName}`)
        const { createHash } = await import('node:crypto')
        const actual = createHash('sha256').update(fs.readFileSync(tmp)).digest('hex')
        if (actual.toLowerCase() !== expected[0].toLowerCase()) {
          try { fs.unlinkSync(tmp) } catch { /* ignore */ }
          throw new Error(`SHA256 mismatch for ${fileName}: expected ${expected[0]}, got ${actual}`)
        }
        log(`sha256 ok (${bytes} bytes)`)
        const tar = findTar()
        if (!tar) throw new Error('no tar on PATH to unpack the release')
        const extractTo = path.join(paths.root, `.extract-${Date.now()}`)
        fs.rmSync(extractTo, { recursive: true, force: true })
        fs.mkdirSync(extractTo, { recursive: true })
        const unpack = await run(tar, ['-xf', tmp, '-C', extractTo], { timeoutMs: 180_000 })
        if (unpack.code !== 0) throw new Error(`tar failed: ${(unpack.stderr || '').trim().slice(0, 300)}`)
        const found = findBinary(extractTo)
        if (!found) throw new Error(`the archive did not contain ${EXE_NAME}`)
        fs.mkdirSync(target, { recursive: true })
        fs.copyFileSync(found, binary)
        fs.rmSync(extractTo, { recursive: true, force: true })
        fs.rmSync(tmp, { force: true })
        try { fs.chmodSync(binary, 0o755) } catch { /* not POSIX */ }
        report.push(`installed rust-anything ${tag} -> ${binary}`)
        probeCache.cli = null
        probeCache.version = null
        probeCache.versionAt = 0
        probeCache.doctor = null
        probeCache.doctorAt = 0
        boardCache.clear()
      }
    } catch (error) {
      report.push(`release download failed: ${String(error?.message || error)}`)
    }
  }

  const resolved = resolveCli(config)
  if (!resolved.cli || options.force === true) {
    const cargo = which('cargo')
    if (cargo) {
      log('running cargo install rust-anything')
      const result = await run(cargo, ['install', 'rust-anything', '--locked', '--root', paths.root], {
        timeoutMs: 900_000,
        signal: options.signal,
      })
      report.push(result.code === 0 ? `cargo install finished (root ${paths.root})` : `cargo install exited ${result.code}: ${(result.stderr || '').trim().slice(0, 400)}`)
      const found = findBinary(paths.root)
      if (found && found !== path.join(paths.root, 'bin', EXE_NAME)) {
        try {
          fs.mkdirSync(path.join(paths.root, 'bin'), { recursive: true })
          fs.copyFileSync(found, path.join(paths.root, 'bin', EXE_NAME))
        } catch { /* resolveCli also knows the cargo layout */ }
      }
    } else {
      report.push('cargo is not on PATH, so the source fallback is unavailable: install Rust (rustup) or run `npm i -g rust-anything` yourself')
    }
  }

  const skill = installSkill(report)
  const after = resolveCli(config)
  return {
    ok: Boolean(after.cli),
    version: after.cli ? await versionOf(after, true) : null,
    cliPath: after.cli,
    cliSource: after.source,
    root: paths.root,
    skill,
    report,
  }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------
// doctor is a cross-platform probe, and two of its checks lie on Windows: `cc --version` can never
// succeed there (MSVC has no cc binary) and `cargo --version` fails when ~/.cargo/bin is merely off
// PATH. The page and ra_status show doctor's findings decorated with what we can verify locally, and
// every row says what its button would do: install, fix PATH, or nothing (by design).
// ---- path normalisation ---------------------------------------------------------------------
//
// `rust-anything` 2.1 resolves a relative crate path against the wrong base on Windows: `build
// rust\foo-rs` fails with "manifest path ... does not exist" while the absolute path works. The MCP
// tools forward arguments verbatim, so an agent saying "build rust/foo-rs" hits that bug. Resolve
// the path-shaped arguments against the session's directory before forwarding.

const ALWAYS_PATHS = new Set(['root', 'repo', 'cwd'])
const IF_EXISTS_PATHS = new Set(['crate'])

/** Resolve one path argument; `mustExist` keeps names (a unit id, a crate name) untouched. */
export function absolutizePath(value, base, mustExist = false) {
  if (typeof value !== 'string' || !value.trim()) return value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  const resolved = path.resolve(base, value)
  if (!mustExist) return resolved
  if (fs.existsSync(resolved)) return resolved
  const underRust = path.resolve(base, 'rust', value)
  if (fs.existsSync(underRust)) return underRust
  return value
}

/** Rewrite the path-shaped arguments of one MCP call. Unknown shapes are left alone. */
export function normalizeToolArgs(args, base) {
  if (!args || typeof args !== 'object') return args
  const out = { ...args }
  // `root`/`repo` define the project; a relative `out` belongs to *that* folder, not to the session
  // directory. Resolving it against the session would drop a crate outside the repository whenever
  // the two differ.
  const projectRoot = typeof out.root === 'string' || typeof out.repo === 'string'
    ? path.resolve(base, String(out.root ?? out.repo))
    : base
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value) && key === 'crates') {
      out[key] = value.map((entry) => absolutizePath(entry, base, false))
    } else if (key === 'out') {
      out[key] = absolutizePath(value, projectRoot, false)
    } else if (ALWAYS_PATHS.has(key)) {
      out[key] = absolutizePath(value, base, false)
    } else if (IF_EXISTS_PATHS.has(key)) {
      out[key] = absolutizePath(value, base, true)
    }
  }
  return out
}

// Subcommands whose second argument is a crate folder; the CLI has the same relative-path bug.
const CRATE_SUBCOMMANDS = new Set(['build', 'diff', 'bench', 'gate', 'shadow', 'refresh', 'record'])

/** Fix `ra_cli ["build", "rust/foo-rs"]` the same way, without touching any other argument. */
export function normalizeCliArgs(argv, base) {
  if (!Array.isArray(argv) || argv.length < 2) return argv
  const out = argv.slice()
  if (CRATE_SUBCOMMANDS.has(String(out[0]))) {
    out[1] = absolutizePath(out[1], base, true)
  }
  return out
}

const NOT_INSTALLABLE = {
  agents: 'doctor 的修法是 rust-anything setup，注册的是 Claude Code / Codex / Cursor / Gemini CLI / OpenCode；这个 Harness 自己就是 agent',
  'mcp server': '插件自带 MCP 客户端，无需安装',
}

export function decorateDoctorChecks(checks, local) {
  const known = local || {}
  return (checks || []).map((check) => {
    const name = String(check.name)
    const entry = {
      name,
      status: String(check.status),
      required: Boolean(check.required),
      detail: String(check.detail || ''),
      fix: check.fix || null,
      doctorStatus: String(check.status),
      installable: true,
      suggested: 'install',
    }
    entry.weight = CHECKS[name] && CHECKS[name].weight ? CHECKS[name].weight : 'small'
    // Newer CLI builds split `agents` into one row per target (`Claude Code mcp`, `Gemini CLI mcp`,
    // …); the card keys off this field, so an exact-name map alone leaves them looking installable.
    const blocked = NOT_INSTALLABLE[name]
      || (neverInstalled(name) ? '给其他编码 CLI 注册本 CLI 的说明文件，本插件不装' : null)
    if (blocked) {
      entry.installable = false
      entry.suggested = 'skip'
      entry.note = blocked
      return entry
    }
    if (name === 'cc' && IS_WINDOWS && known.cc === 'ok') {
      entry.status = 'ok'
      entry.suggested = 'skip'
      entry.detail = `MSVC 链接器已就绪：${known.ccPath || 'vswhere 已确认 VC Tools'}`
      entry.note = 'doctor 执行的是 `cc --version`，Windows 上永远不过；cargo 真正要的是 link.exe，用 vswhere 判定'
      return entry
    }
    if (name === 'cc' && IS_WINDOWS) {
      entry.note = '需要 VS Build Tools 的 C++ 组件（提供 link.exe），几个 GB'
      return entry
    }
    if (name === 'cargo' && known.cargo === 'path-only') {
      entry.suggested = 'fixpath'
      entry.note = '已装但不在 PATH 上；点一下只把 ~/.cargo/bin 写进用户 PATH，不重装'
      return entry
    }
    if (name === 'cargo' && known.cargo === 'ok') {
      entry.status = 'ok'
      entry.suggested = 'skip'
      entry.detail = 'cargo 可用'
      return entry
    }
    if (name === 'kotlinc' && known.kotlinc === 'ok') {
      entry.status = 'ok'
      entry.suggested = 'skip'
      entry.detail = 'kotlinc 已装（.bat 启动器）'
      entry.note = 'doctor 直接 spawn `kotlinc`，而 Windows 上它只有 .bat；PATH 里能解析到就算就绪'
      return entry
    }
    // Anything doctor and the local probe agree is fine gets no button, whatever its name.
    if (entry.status === 'ok') entry.suggested = 'skip'
    return entry
  })
}

let localStatusCache = { at: 0, value: null }
async function localChecks() {
  if (localStatusCache.value && Date.now() - localStatusCache.at < 60_000) return localStatusCache.value
  const value = await localStatus(run, await freshEnv())
  localStatusCache = { at: Date.now(), value }
  return value
}

/**
 * A job killed from outside (task manager, a reboot, an app restart) leaves `running: true` on disk
 * forever; the in-process flag is the only thing that knows better. Settle it once and persist, so
 * every read path — status, board, the bootstrap route — agrees instead of showing "installing" for
 * hours after the child process is gone.
 */
function settledBootstrapJob(root) {
  const stored = readJson(bootstrapStateFile(root))
  if (!stored) return null
  if (bootstrapJob.running) return bootstrapJob
  const job = { ...stored, running: false, stale: stored.running === true || stored.stale === true }
  if (stored.running === true) {
    job.output = [...(stored.output || []), 'that run ended when the harness restarted']
    try { fs.writeFileSync(bootstrapStateFile(root), `${JSON.stringify(job, null, 2)}\n`) } catch { /* best effort */ }
  }
  return job
}

async function statusReport(config, options = {}) {
  const resolved = resolveCli(config)
  const paths = statePaths(config)
  const surface = readSurface(config)
  const runtime = options.runtime || {}
  const report = {
    installed: Boolean(resolved.cli),
    cliPath: resolved.cli,
    cliSource: resolved.source,
    root: paths.root,
    version: null,
    versions: versionedFirst(listDirs(paths.root)).filter((name) => /^\d+\.\d+\.\d+/.test(name)),
    prerequisites: {
      cargo: which('cargo') || null,
      node: which('node') || null,
      rustup: which('rustup') || null,
    },
    mcp: {
      serverName: SERVER_NAME,
      toolPrefix: TOOL_PREFIX,
      total: Number.isFinite(runtime.total) ? runtime.total : 16,
      visible: Number.isFinite(runtime.visible) ? runtime.visible : null,
      running: runtime.running === true,
      serverVersion: runtime.serverVersion || null,
      client: runtime.client || null,
      lastError: runtime.lastError || null,
      surfaces: SURFACE_ORDER,
    },
    surface,
    skill: {
      dir: SKILL_ROOT,
      installed: existsFile(path.join(SKILL_ROOT, 'SKILL.md')),
      registered: skillRegistration.ok,
      registerError: skillRegistration.error,
    },
    project: projectReport(options.projectDir || config.projectDir || process.cwd()),
    projectSource: options.projectSource || (options.projectDir ? 'explicit' : config.projectDir ? 'projectDir' : 'cwd'),
    install: readJson(paths.installFile),
    bootstrap: { plans: Object.keys(PLANS), lastJob: settledBootstrapJob(paths.root) },
    notes: [],
  }
  if (resolved.cli) {
    const version = await versionOf(resolved, options.refresh === true)
    report.version = version
    if (options.doctor === true) {
      const raw = await doctorOf(resolved, options.refresh === true)
      const local = await localChecks()
      report.doctor = raw && Array.isArray(raw.checks) ? { ...raw, checks: decorateDoctorChecks(raw.checks, local) } : raw
    }
  } else {
    report.notes.push('rust-anything is not installed yet: run the ra_install tool (or the install button on the Rust Anything page).')
  }
  // An empty session workspace is the normal first-run state in DSH: say so instead of listing a
  // project with nothing in it, and name the two ways to point at a real repository.
  if (!report.project.languages.length && !report.project.crates.length && !report.project.isRustProject) {
    report.notes.push('这个目录里没有检测到可移植的源语言（空工作台？）。用 ra_status {projectDir:"<仓库>"} 指定仓库，或在 DSH 里把会话工作区切到该仓库。')
  }
  if (!report.skill.installed) {
    report.notes.push(`the workflow skill is not in ${SKILL_ROOT}; call ra_install with skillOnly:true, or copy skills/rust-anything/ there by hand.`)
  }
  if (!report.mcp.running && report.installed) {
    report.notes.push(`the MCP client is not serving tools (${report.mcp.lastError || 'not started yet'}); ra_install or reloading the plugin starts it.`)
  }
  if (options.projectDir && !fs.existsSync(path.resolve(String(options.projectDir)))) {
    report.notes.push(`project folder does not exist: ${options.projectDir}`)
  }
  return report
}

function renderStatus(value) {
  const lines = []
  lines.push(value.installed ? `rust-anything: ${value.version || 'unknown version'}` : 'rust-anything: NOT INSTALLED')
  if (value.cliPath) lines.push(`  binary: ${value.cliPath} (${value.cliSource})`)
  lines.push(`  install root: ${value.root}`)
  if (value.versions.length) lines.push(`  versions on disk: ${value.versions.join(', ')}`)
  lines.push('')
  const project = value.project
  const originals = project.languages.length ? project.languages.join(', ') : (project.isRustProject ? 'rust (already)' : 'none detected')
  lines.push(`project: ${project.root}`)
  lines.push(`  original language: ${originals}`)
  lines.push(`  crates: ${project.crates.length}${project.crates.length ? ` (${project.crates.map((crate) => `${crate.crate}: ${crate.exports} exports, ${crate.cases ?? '?'} cases`).join('; ')})` : ''}`)
  if (project.app) lines.push(`  whole app: ${project.app.cases} recorded cases${project.app.frontDoor ? ', rust/app front door present' : ', no front door yet'}`)
  if (project.portMap) lines.push(`  port map: ${project.portMap.file} (${project.portMap.mtime})`)
  lines.push('')
  const mcp = value.mcp
  lines.push(`MCP: "${mcp.serverName}" -> ${mcp.toolPrefix}* ${mcp.running ? `running (server ${mcp.serverVersion || '?'})` : 'NOT RUNNING'}`)
  lines.push(`  surface: ${value.surface.surface} = ${surfaceScope(value.surface)}${mcp.visible === null ? '' : `; visible ${mcp.visible}/${mcp.total}`}`)
  if (mcp.lastError) lines.push(`  last error: ${mcp.lastError}`)
  lines.push(`  skill: ${value.skill.registered ? 'registered on the Harness' : 'NOT REGISTERED'}${value.skill.installed ? ` (file copy: ${value.skill.dir})` : ' (no file copy)'}`)
  if (value.doctor) {
    const bad = value.doctor.checks ? value.doctor.checks.filter((check) => check.status !== 'ok') : []
    lines.push(`  doctor: ${value.doctor.ok ? 'all required checks pass' : `${bad.length} check(s) need attention`}`)
    for (const check of bad.slice(0, 8)) lines.push(`    - ${check.name}: ${check.status}${check.fix ? ` (fix: ${check.fix})` : ''}`)
    if (value.doctor.error) lines.push(`    ${value.doctor.error}`)
  }
  for (const note of value.notes) lines.push(`note: ${note}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------
function statusTool(config, hooks) {
  return {
    name: 'ra_status',
    description:
      'Report the local rust-anything install and the current project: CLI path, version and source (plugin data, PATH, cargo, npm), what `rust-anything doctor` says when asked, the original language detected in the folder, every crate under rust/ with its exports/cases, whether a whole-app port exists, whether this plugin’s MCP client is serving tools (visible/total on the current surface) and whether the workflow skill is installed. Read-only; results are cached for a few minutes.',
    parameters: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Repository to inspect (defaults to the configured project folder or the current directory).' },
        refresh: { type: 'boolean', description: 'Re-run `--version` (and doctor) instead of using the cache.' },
        doctor: { type: 'boolean', description: 'Also run `rust-anything doctor --json` and list what it flags (slower: it probes runtimes).' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderStatus(value),
    },
    async execute(args, exec) {
      const info = resolveBaseDirInfo(config, exec)
      return statusReport(config, {
        runtime: hooks.runtimeSnapshot(),
        projectDir: args?.projectDir ? path.resolve(info.dir, String(args.projectDir)) : info.dir,
        projectSource: args?.projectDir ? 'explicit' : info.source,
        refresh: args?.refresh === true,
        doctor: args?.doctor === true,
      })
    },
  }
}

function cliTool(config) {
  return {
    name: 'ra_cli',
    description:
      'Run the local rust-anything CLI with any arguments and return exit code, stdout and stderr. Use it for the workflow commands that are not MCP tools: `doctor`, `doctor --json`, `setup` (registers other agents, not this Harness), `report`, `map --write`, `app record ... -- args`, `commands`, and anything the MCP surface is not exposing right now. The argument array is passed verbatim (no shell). Long runs (record, build, gate, app lift) need a large timeoutMs; cancelling the call kills the child.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact CLI arguments, e.g. ["analyze",".","--json"] or ["gate","rust/fuzzy-rs"].',
        },
        cwd: { type: 'string', description: 'Working directory (defaults to the configured project folder, else the current directory).' },
        timeoutMs: { type: 'integer', description: 'Kill the command after this many milliseconds (default 180000, 0 = no timeout).' },
        maxOutputChars: { type: 'integer', description: 'Trim each stream to this many characters for the model (default 8000, max 60000). The exit code is always reported.' },
      },
      required: ['args'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [`$ ${value.command}`, `exit ${value.exitCode ?? 'null'}${value.timedOut ? ' (timed out, killed)' : ''} in ${value.ms} ms`]
        if (value.stdout) lines.push('--- stdout ---', value.stdout.trimEnd())
        if (value.stderr) lines.push('--- stderr ---', value.stderr.trimEnd())
        if (!value.stdout && !value.stderr) lines.push('(no output)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const resolved = resolveCli(config)
      if (!resolved.cli) {
        throw new Error('rust-anything is not installed. Run ra_install first (it downloads the official release and verifies its SHA256).')
      }
      const base = resolveBaseDir(config, exec)
      const argv = normalizeCliArgs(Array.isArray(args?.args) ? args.args.map(String) : [], base)
      if (argv.length === 0) throw new Error('args must contain at least one CLI argument, e.g. ["analyze",".","--json"].')
      const timeoutMs = Number.isFinite(args?.timeoutMs) ? Math.max(0, Math.trunc(args.timeoutMs)) : 180_000
      const cwd = args?.cwd ? path.resolve(base, String(args.cwd)) : (config.projectDir || base)
      const maxChars = Math.min(60_000, Math.max(500, Number.isFinite(args?.maxOutputChars) ? Math.trunc(args.maxOutputChars) : 8_000))
      const result = await run(resolved.cli, argv, { cwd, timeoutMs, signal: exec?.signal })
      const command = [resolved.cli, ...argv].map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(' ')
      const trim = (text) => {
        const value = text.trimEnd()
        if (value.length <= maxChars) return value
        return `${value.slice(0, maxChars)}\n... [${value.length - maxChars} more characters trimmed; raise maxOutputChars or read the CLI output yourself]`
      }
      const payload = {
        ok: result.code === 0,
        exitCode: result.timedOut ? null : result.code,
        timedOut: Boolean(result.timedOut),
        stdout: trim(result.stdout),
        stderr: trim(result.stderr),
        command,
        cwd: cwd || process.cwd(),
        ms: result.ms,
      }
      if (result.error) payload.error = result.error
      boardCache.clear()
      return payload
    },
  }
}

function installTool(config, hooks) {
  return {
    name: 'ra_install',
    description:
      'Download or update the official rust-anything CLI for this machine from github.com/erkamyaman/rust-anything releases into the plugin data directory, verifying SHA256SUMS before unpacking, then unpack with tar. Falls back to `cargo install rust-anything --locked` when the release download fails or cargo is the only path. Also installs the workflow skill into the harness skills folder (SKILL.md + whole-app.md). On success the plugin restarts its own MCP client in place, so mcp__rust_anything__* tools come from the new binary without a Harness restart.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Release tag such as "v2.0.0", or "latest" (default).' },
        force: { type: 'boolean', description: 'Re-download even when that version is already present, and prefer the cargo path.' },
        skillOnly: { type: 'boolean', description: 'Only (re)install the workflow skill; do not touch the binary.' },
        cancel: { type: 'boolean', description: 'Stop an install that is already downloading.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [value.ok ? `rust-anything ${value.version || ''} ready: ${value.cliPath || '?'}` : 'rust-anything is still not installed']
        if (value.skill) lines.push(`skill: ${value.skill.ok ? value.skill.dir : 'NOT installed'}`)
        if (value.client) lines.push(`MCP client: ${value.client}`)
        if (value.report && value.report.length) lines.push('', ...value.report)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      if (args?.cancel === true) {
        try { installAbort?.abort() } catch { /* already gone */ }
        return { ok: true, cancelled: true, version: null, cliPath: resolveCli(config).cli, root: installRoot(config), skill: null, report: ['asked the running install to stop'] }
      }
      if (args?.skillOnly === true) {
        const report = []
        const skill = installSkill(report)
        return { ok: skill.ok, version: null, cliPath: resolveCli(config).cli, root: installRoot(config), skill, report, client: null }
      }
      const result = await installCli(config, {
        version: args?.version ? String(args.version) : 'latest',
        force: args?.force === true,
        signal: exec?.signal,
      })
      let client = null
      if (result.ok) {
        try {
          client = await hooks.restartClient()
        } catch (error) {
          client = `restart failed: ${String(error && error.message ? error.message : error)}`
        }
      }
      return { ...result, client }
    },
  }
}

function surfaceTool(config, hooks) {
  return {
    name: 'ra_surface',
    description:
      'Read or switch which rust-anything MCP tools this Harness can see. Tiers: "off" (no tools), "plan" (read-only tools plus bridge/refresh/profile), "port" (every tool the server lists), "all" (same as port, including the app_* ones). Tiers are decided from each tool\'s read-only annotation, so tools the CLI adds later appear without editing the plugin. The surface is written to bridge.json and re-applied to the tool registry immediately — no restart, no reconnect. Call with no argument to read it, or pass an explicit allow list of glob patterns.',
    parameters: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: SURFACE_ORDER, description: 'Tier to switch to. Leave out to read the current one.' },
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit glob patterns instead of a tier, e.g. ["analyze","map","app_*"]. An empty list allows every tool.',
        },
        enabled: { type: 'boolean', description: 'With allow: false hides every tool (same as surface "off").' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const counts = value.mcp.total ? ` — visible ${value.mcp.visible ?? '?'}/${value.mcp.total}` : ''
        return [{
          type: 'text',
          text: `rust-anything tool surface: ${value.surface} = ${surfaceScope(value)}${counts}`,
        }]
      },
    },
    async execute(args) {
      let patch = null
      if (args && typeof args.surface === 'string') {
        const tier = SURFACES[args.surface]
        if (!tier) throw new Error(`unknown surface "${args.surface}"; use one of ${SURFACE_ORDER.join(', ')}`)
        patch = tier
      } else if (args && Array.isArray(args.allow)) {
        patch = { enabled: args.enabled !== false, allow: args.allow.map(String) }
      } else if (args && args.enabled === false) {
        patch = SURFACES.off
      }
      if (patch) writeSurface(config, patch)
      const applied = await hooks.applySurface()
      return { ...readSurface(config), mcp: applied }
    },
  }
}

function renderBootstrap(value) {
  if (!value.items) {
    return [{ type: 'text', text: `bootstrap ${value.plan || ''} started in the background at ${value.startedAt || '?'}.\n${value.hint || ''}` }]
  }
  const lines = [`bootstrap: plan ${value.plan}${value.dryRun ? ' (dry run, nothing changed)' : ''} in ${Math.round((value.ms || 0) / 1000)} s`]
  for (const item of value.items || []) {
    const state = item.status || item.action
    lines.push(`  - ${item.id}: ${state} — ${item.label || ''}${item.detail && state !== 'install' ? ` (${item.detail})` : ''}`)
    if (item.command) lines.push(`      ${item.command}`)
    if (item.error) lines.push(`      error: ${item.error}`)
  }
  for (const key of ['doctorBefore', 'doctorAfter']) {
    const info = value[key]
    if (!info) continue
    const label = key === 'doctorBefore' ? 'before' : 'after'
    if (info.error) lines.push(`doctor ${label}: ${info.error}`)
    else lines.push(`doctor ${label}: ${info.ok}/${info.total} ok${info.stillMissing.length ? ` — still missing: ${info.stillMissing.join(', ')}` : ''}`)
  }
  if (value.dryRun) lines.push('run again without dryRun to install; a large item (MSVC Build Tools) takes 10-20 minutes')
  return [{ type: 'text', text: lines.join('\n') }]
}

function bootstrapTool(config, hooks) {
  return {
    name: 'ra_bootstrap',
    description:
      'Install the toolchains rust-anything needs but no package can carry, driven by `rust-anything doctor --json`. Plans: "rust" (cargo + the MSVC linker — the two hard blockers for bridge/build/gate/bench), "ts" (+ Node 22+), "python", "go", "ruby", "java", "wasm" (+ the wasm32 target and wasm-bindgen-cli), "all". Downloads the official rustup-init for cargo, uses winget for the rest (silent, agreements accepted), refreshes PATH between steps, re-runs doctor at the end and reports what is still missing. Never installs coding agents: doctor’s fix there is `rust-anything setup`, which registers Claude Code / Codex / Cursor / Gemini CLI / OpenCode, not this Harness. Call with dryRun first to see the exact commands.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', enum: Object.keys(PLANS), description: 'Preset of checks for a kind of project (default "rust").' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Explicit doctor check names instead of a plan, e.g. ["cargo","cc"].' },
        dryRun: { type: 'boolean', description: 'Print what would run and change nothing.' },
        cancel: { type: 'boolean', description: 'Stop a bootstrap that is already running (kills the download/build child).' },
        mirror: { type: 'string', enum: ['auto', 'official', 'cn', 'rsproxy'], description: 'Where rustup downloads from. auto (default) measures the official channel manifest for a few seconds and falls back to the CN mirror when it is throttled; cn is the TUNA mirror; rsproxy is the other CN mirror.' },
        proxy: { type: 'string', description: 'HTTP proxy for the child processes, e.g. http://127.0.0.1:7897. Passed as HTTP_PROXY/HTTPS_PROXY to rustup, cargo and winget; needed when crates.io or the release download has to go through it.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderBootstrap(value),
    },
    async execute(args, exec) {
      const resolved = resolveCli(config)
      if (!resolved.cli) throw new Error('rust-anything is not installed; run ra_install first (doctor is what plans this)')
      fs.mkdirSync(installRoot(config), { recursive: true })
      if (args?.cancel === true) {
        const stopped = startBootstrapJob(config, hooks, { cancel: true })
        return { ok: true, cancelled: Boolean(stopped.cancelled), hint: 'an in-flight bootstrap was asked to stop; its curl child is killed and the job ends' }
      }
      const started = startBootstrapJob(config, hooks, {
        plan: typeof args?.plan === 'string' ? args.plan : 'rust',
        ids: Array.isArray(args?.ids) ? args.ids.map(String) : undefined,
        mirror: typeof args?.mirror === 'string' ? args.mirror : 'auto',
        proxy: typeof args?.proxy === 'string' ? args.proxy : undefined,
        dryRun: args?.dryRun === true,
      })
      if (!started.ok) throw new Error(started.error)

      // A dry run is instant and belongs inline; a real run must not hold the conversation hostage —
      // the NDK alone takes hours. `wait: true` opts back into blocking, capped at ten minutes.
      const waitFor = async (ms) => {
        const deadline = Date.now() + ms
        while (bootstrapJob.running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300))
        return bootstrapJob
      }
      if (args?.dryRun === true) return { ...(await waitFor(30_000)), dryRun: true }
      if (args?.wait === true) {
        const job = await waitFor(10 * 60_000)
        return { ...job, hint: job.running ? 'still running after 10 minutes; the env card keeps showing progress' : 'finished' }
      }
        // Wait briefly so the caller sees the first lines instead of a bare "started", which a model         // happily reports to the user as "done".         const deadline = Date.now() + 2500         while (bootstrapJob.running && bootstrapJob.output.length < 3 && Date.now() < deadline) {           await new Promise((resolve) => setTimeout(resolve, 150))         }
      return {
        ok: true,
        running: bootstrapJob.running,
        plan: started.plan,
        startedAt: started.startedAt,
        output: bootstrapJob.output.slice(0, 8),
        hint: 'started in the background: progress and the log are on the Rust Anything page (环境与依赖), or GET /rust-anything/api/bootstrap. Call ra_bootstrap again with wait:true to block instead.',
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP: one bearer token per Harness process, loopback + Host/Origin fence, then the handler.
// ---------------------------------------------------------------------------------------------
const TOKEN_ROUTE = '/rust-anything/api/token'
const STATUS_ROUTE = '/rust-anything/api/status'
const SURFACE_ROUTE = '/rust-anything/api/surface'
const BOARD_ROUTE = '/rust-anything/api/board'
const INSTALL_ROUTE = '/rust-anything/api/install'
const BOOTSTRAP_ROUTE = '/rust-anything/api/bootstrap'

function tokenRouteHandler(auth) {
  return (req, res) => {
    // Bootstrap only: the DSH connection admission plus the loopback fence, no bearer required.
    if (rejectRequest(req, res, auth, { token: false })) return
    sendJson(res, 200, { ok: true, token: auth.token })
  }
}

function statusRouteHandler(getSettings, hooks) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const projectDir = url.searchParams.get('project') || undefined
    sendJson(res, 200, {
      ok: true,
      ...(await statusReport(getSettings(), {
        projectDir,
        doctor: url.searchParams.get('doctor') === '1',
        // No agent on an HTTP request, so the page can never know the session directory.
        projectSource: projectDir ? 'explicit' : getSettings().projectDir ? 'projectDir' : 'cwd',
        // ?doctor=1 may serve the cached verdict; only refresh=1 (the 运行诊断 button) re-probes.
        // Opening the page used to spawn the CLI and vswhere every time, which made it feel slow.
        refresh: url.searchParams.get('refresh') === '1',
        runtime: hooks.runtimeSnapshot(),
      })),
    })
  }
}

function boardRouteHandler(getSettings) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    sendJson(res, 200, { ok: true, ...(await boardReport(getSettings(), url.searchParams.get('project') || undefined)) })
  }
}

function surfaceRouteHandler(getSettings, hooks) {
  return async (req, res) => {
    const settings = getSettings()
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      const body = await readJsonBody(req)
      let patch = null
      if (typeof body.surface === 'string' && SURFACES[body.surface]) patch = SURFACES[body.surface]
      else if (Array.isArray(body.allow)) patch = { enabled: body.enabled !== false, allow: body.allow.map(String) }
      if (!patch) return sendJson(res, 400, { ok: false, error: 'body must be {"surface":"off|plan|port|all"} or {"allow":[...]}' })
      writeSurface(settings, patch)
    }
    const applied = await hooks.applySurface()
    sendJson(res, 200, { ok: true, ...readSurface(settings), mcp: applied, mcpTools: hooks.registryCounts() })
  }
}

let installJob = { running: false, startedAt: null, finishedAt: null, ok: null, output: [], version: null }
let installAbort = null
const INSTALL_TIMEOUT_MS = 30 * 60_000
let bootstrapJob = { running: false, plan: null, startedAt: null, finishedAt: null, ok: null, items: [], doctorBefore: null, doctorAfter: null }
let bootstrapAbort = null

function installRouteHandler(getSettings, hooks) {
  return async (req, res) => {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      return sendJson(res, 200, { ok: true, job: installJob })
    }
    if (installJob.running) {
      const pending = await readJsonBody(req).catch(() => ({}))
      if (pending.cancel === true) {
        // A GitHub download can hang for minutes; without this the page had no way out.
        try { installAbort?.abort() } catch { /* already gone */ }
        return sendJson(res, 200, { ok: true, cancelled: true, job: installJob })
      }
      return sendJson(res, 409, { ok: false, error: 'an install is already running', job: installJob })
    }
    const body = await readJsonBody(req).catch(() => ({}))
    const settings = getSettings()
    const paths = statePaths(settings)
    installJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, output: [], version: null }
    installAbort = new AbortController()
    const ceiling = setTimeout(() => { try { installAbort.abort() } catch { /* gone */ } }, INSTALL_TIMEOUT_MS)
    if (ceiling.unref) ceiling.unref()
    const push = (line) => {
      const text = String(line)
      installJob.output.push(text)
      try {
        fs.mkdirSync(paths.root, { recursive: true })
        fs.writeFileSync(paths.installFile, `${JSON.stringify(installJob, null, 2)}\n`)
      } catch { /* best effort */ }
    }
    sendJson(res, 202, { ok: true, job: installJob })
    installCli(settings, {
      version: typeof body.version === 'string' ? body.version : 'latest',
      force: body.force === true,
      signal: installAbort.signal,
      log: push,
    }).then(async (result) => {
      clearTimeout(ceiling)
      for (const line of result.report) push(line)
      if (result.ok) {
        try { await hooks.restartClient() } catch (error) { push(`MCP client restart failed: ${String(error && error.message ? error.message : error)}`) }
      }
      installJob = { ...installJob, running: false, finishedAt: new Date().toISOString(), ok: result.ok, version: result.version }
      push(result.ok ? `done: ${result.cliPath}` : 'install failed; see the lines above')
    }).catch((error) => {
      clearTimeout(ceiling)
      installJob = { ...installJob, running: false, finishedAt: new Date().toISOString(), ok: false }
      const message = String(error && error.message ? error.message : error)
      push(message === 'This operation was aborted' ? 'install cancelled' : message)
    })
  }
}

/**
 * Start a bootstrap job and return its snapshot immediately. The NDK alone is two hours on this
 * network, so nothing may block a tool call on it: the job keeps running in the host process and
 * the environment card (or GET /bootstrap) shows the log.
 */
function startBootstrapJob(settings, hooks, request = {}) {
  const root = installRoot(settings)
  const resolved = resolveCli(settings)
  if (!resolved.cli) return { ok: false, error: 'rust-anything is not installed; run ra_install first' }
  if (request.cancel === true) {
    // The NDK can sit for hours behind a throttled CDN; a job with no way out is not acceptable.
    try { bootstrapAbort?.abort() } catch { /* already gone */ }
    return { ok: true, cancelled: true }
  }
  if (bootstrapJob.running) return { ok: false, error: 'a bootstrap is already running', job: bootstrapJob }
  const plan = typeof request.plan === 'string' && PLANS[request.plan] ? request.plan : 'rust'
  bootstrapJob = {
    running: true,
    plan,
    dryRun: request.dryRun === true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    items: [],
    output: [],
    doctorBefore: null,
    doctorAfter: null,
  }
  bootstrapAbort = new AbortController()
  const push = (line) => {
    bootstrapJob.output.push(String(line))
    if (bootstrapJob.output.length > 400) bootstrapJob.output.splice(0, bootstrapJob.output.length - 400)
    try { fs.writeFileSync(bootstrapStateFile(root), `${JSON.stringify(bootstrapJob, null, 2)}\n`) } catch { /* best effort */ }
  }
  runBootstrap({
    run,
    cli: resolved.cli,
    root,
    plan,
    ids: Array.isArray(request.ids) ? request.ids.map(String) : undefined,
    mirror: typeof request.mirror === 'string' ? request.mirror : 'auto',
    proxy: typeof request.proxy === 'string' ? request.proxy : undefined,
    dryRun: request.dryRun === true,
    signal: bootstrapAbort.signal,
    log: push,
  }).then((job) => {
    bootstrapJob = { ...bootstrapJob, ...job, running: false, finishedAt: new Date().toISOString() }
    push(job.ok ? 'bootstrap finished' : 'bootstrap finished with failures; see the items above')
    probeCache.version = null
    probeCache.versionAt = 0
    probeCache.doctor = null
    probeCache.doctorAt = 0
    whichCache.clear()
  }).catch((error) => {
    bootstrapJob = { ...bootstrapJob, running: false, ok: false, finishedAt: new Date().toISOString() }
    push(String(error && error.message ? error.message : error))
  })
  return { ok: true, running: true, plan, startedAt: bootstrapJob.startedAt }
}

function bootstrapRouteHandler(getSettings, hooks) {
  return async (req, res) => {
    const settings = getSettings()
    const root = installRoot(settings)
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      // A job killed from outside (task manager, a reboot, a restart) leaves running:true in the
      // file forever; the in-process flag is the only thing that knows better.
      const job = settledBootstrapJob(root) || bootstrapJob
      return sendJson(res, 200, { ok: true, plans: Object.keys(PLANS), job })
    }
    const body = await readJsonBody(req).catch(() => ({}))
    const started = startBootstrapJob(settings, hooks, body)
    if (started.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, job: bootstrapJob })
    if (!started.ok) return sendJson(res, started.error.includes('already running') ? 409 : 400, started)
    sendJson(res, 202, { ok: true, job: bootstrapJob })
  }
}
// ---------------------------------------------------------------------------------------------
export const inject = ['tools']

// The Session's own directory, when this Harness publishes the working-directory service. A tool
// call carries the agent, so "which project?" is the folder the user works in 鈥?not the folder the
// Electron process happens to sit in, which is what process.cwd() gave before.
let workingDirectoryService = null

/**
 * Where the base directory came from: `session` is the folder the user is working in, `projectDir`
 * is configured, `cwd` is the harness process directory — which is only meaningful for a tool call,
 * never for an HTTP request (the page has no session).
 */
export function resolveBaseDirInfo(settings, exec) {
  try {
    const session = exec && exec.agent ? exec.agent.session : null
    if (session && workingDirectoryService && typeof workingDirectoryService.get === 'function') {
      const dir = workingDirectoryService.get(session)
      if (typeof dir === 'string' && dir) return { dir, source: 'session' }
    }
  } catch { /* service absent, or the session has no directory yet */ }
  if (settings && settings.projectDir) return { dir: settings.projectDir, source: 'projectDir' }
  return { dir: process.cwd(), source: 'cwd' }
}

/** Base directory for path arguments and default cwds. */
export function resolveBaseDir(settings, exec) {
  return resolveBaseDirInfo(settings, exec).dir
}

export function apply(ctx, config) {
  // A patch row with only comments parses as `config: null`.
  const raw = config || {}
  const settings = {
    cliPath: typeof raw.cliPath === 'string' && raw.cliPath.trim() ? raw.cliPath.trim() : undefined,
    installDir: typeof raw.installDir === 'string' && raw.installDir.trim() ? raw.installDir.trim() : undefined,
    projectDir: typeof raw.projectDir === 'string' && raw.projectDir.trim() ? raw.projectDir.trim() : undefined,
    trustedHosts: Array.isArray(raw.trustedHosts) ? raw.trustedHosts : [],
    installSkillOnBoot: raw.installSkillOnBoot !== false,
    callTimeoutMs: Number.isFinite(raw.callTimeoutMs) ? Math.max(1000, Math.trunc(raw.callTimeoutMs)) : 900_000,
    mcpArgs: Array.isArray(raw.mcpArgs) && raw.mcpArgs.length ? raw.mcpArgs.map(String) : undefined,
  }

  if (settings.installSkillOnBoot) {
    const report = []
    const skill = installSkill(report)
    if (!skill.ok) console.error(`[dsh-rust-anything] skill install: ${report.join('; ')}`)
  }

  // The runtime registration is what this Harness actually reads; the copy above only serves other
  // consumers of <DSH_HOME>/skills and cannot shadow a newer packaged version.
  ctx.inject(['skills'], (skillCtx) => {
    const report = []
    const registered = registerSkill(skillCtx, report)
    if (!registered.ok) console.error(`[dsh-rust-anything] skill register: ${report.join('; ')}`)
  })

  // ---- MCP tools: one registry entry per allowed rust-anything tool ------------------------
  const runtime = {
    client: null,
    tools: [],
    disposers: new Map(),
    total: 0,
    visible: 0,
    lastError: null,
    serverVersion: null,
  }

  const disposeMcpTools = () => {
    for (const dispose of runtime.disposers.values()) {
      try { dispose?.() } catch { /* keep unloading the rest */ }
    }
    runtime.disposers.clear()
  }

  const mcpDefinition = (tool) => {
    const name = `${TOOL_PREFIX}${tool.name}`
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} }
    const readOnly = tool.annotations && tool.annotations.readOnlyHint === true
    return {
      name,
      description: `${tool.description || tool.name}${readOnly ? ' (read-only)' : ''}`,
      parameters: schema,
      timeoutMs: settings.callTimeoutMs,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const blocks = []
          if (value && Array.isArray(value.content)) {
            for (const block of value.content) {
              if (block && block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
            }
          }
          if (blocks.length === 0) {
            const fallback = value && value.structuredContent !== undefined && value.structuredContent !== null
              ? JSON.stringify(value.structuredContent, null, 2)
              : '(rust-anything returned no output)'
            blocks.push({ type: 'text', text: fallback })
          }
          if (value && value.ok === false) blocks.unshift({ type: 'text', text: `rust-anything ${tool.name} failed:` })
          return blocks
        },
      },
      async execute(args, exec) {
        const client = runtime.client
        if (!client) throw new Error('the rust-anything MCP client is not running; call ra_status, then ra_install, then retry')
        const base = resolveBaseDir(settings, exec)
        return client.callTool(tool.name, normalizeToolArgs(args || {}, base), { signal: exec?.signal, timeoutMs: settings.callTimeoutMs })
      },
    }
  }

  const applySurface = () => {
    disposeMcpTools()
    const surface = readSurface(settings)
    const allowed = allowedNames(surface)
    let visible = 0
    for (const tool of runtime.tools) {
      if (!allowed(tool)) continue
      try {
        runtime.disposers.set(tool.name, ctx.tools.register(mcpDefinition(tool)))
        visible += 1
      } catch (error) {
        console.error(`[dsh-rust-anything] cannot register ${TOOL_PREFIX}${tool.name}: ${String(error && error.message ? error.message : error)}`)
      }
    }
    runtime.visible = visible
    runtime.total = runtime.tools.length
    return { surface: surface.surface, allow: surface.allow, visible, total: runtime.total, running: Boolean(runtime.client) }
  }

  // Counted from the registry, not from the last job snapshot: the chip used to show a number up
  // to 20 seconds stale, and the route never sent one at all.
  const registryCounts = () => ({ total: runtime.total, visible: runtime.visible, running: Boolean(runtime.client) })

  const runtimeSnapshot = () => ({
    total: runtime.total,
    visible: runtime.visible,
    running: Boolean(runtime.client),
    serverVersion: runtime.serverVersion,
    lastError: runtime.lastError,
    client: runtime.client ? runtime.client.state : null,
  })

  const stopClient = () => {
    const client = runtime.client
    runtime.client = null
    if (client) {
      try { client.stop() } catch { /* already gone */ }
    }
    disposeMcpTools()
    runtime.tools = []
    runtime.total = 0
    runtime.visible = 0
  }

  const startClient = async () => {
    const resolved = resolveCli(settings)
    if (!resolved.cli) {
      runtime.lastError = 'rust-anything is not installed'
      return runtimeSnapshot()
    }
    const client = createRustAnythingClient({
      cli: resolved.cli,
      argv: settings.mcpArgs,
      cwd: settings.projectDir,
      callTimeoutMs: settings.callTimeoutMs,
    })
    client.onListChanged(() => {
      client.listTools()
        .then((tools) => { runtime.tools = tools; applySurface() })
        .catch((error) => { runtime.lastError = String(error && error.message ? error.message : error) })
    })
    client.onDown((reason) => { runtime.lastError = reason })
    await client.start()
    runtime.client = client
    runtime.serverVersion = client.state.serverVersion
    runtime.tools = await client.listTools()
    runtime.lastError = null
    applySurface()
    syncPromptSection()
    console.error(`[dsh-rust-anything] MCP client up: ${resolved.cli} (${runtime.total} tools, ${runtime.visible} on this surface)`)
    return runtimeSnapshot()
  }

  const restartClient = async () => {
    stopClient()
    const snapshot = await startClient()
    return `running=${snapshot.running} visible=${snapshot.visible}/${snapshot.total}`
  }

  const hooks = { applySurface, registryCounts, runtimeSnapshot, restartClient, startClient, stopClient }

  ctx.inject(['workingDirectory'], (wdCtx) => {
    workingDirectoryService = wdCtx.workingDirectory || null
  })

  // `rust-anything mcp` answers `initialize` with the method itself (profile → record → port one unit
  // at a time). Tool descriptions do not carry it, so dropping it leaves the model holding a toolbox
  // with no procedure. rc.1 renders `text` as a literal string (a closure would be filtered out), so
  // a client restart with different text re-registers the section instead.
  let promptService = null
  let promptDisposer = null
  let promptText = null
  function syncPromptSection() {
    if (!promptService) return
    const state = runtime.client ? runtime.client.state : null
    const text = state && state.instructions ? state.instructions : null
    if (!text || text === promptText) return
    if (promptDisposer) {
      try { promptDisposer() } catch { /* an already-disposed section is not an error */ }
      promptDisposer = null
    }
    try {
      promptDisposer = promptService.section({
        name: 'mcp:rust-anything',
        order: promptService.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: `${text}\n\nIn this Harness these are the mcp__rust_anything__* tools. Do not fall back to a rust-anything CLI, to \`rust-anything setup\` or to a PATH change: call ra_install or ra_status instead.`,
      })
      promptText = text
    } catch (error) {
      console.error(`[dsh-rust-anything] cannot publish the MCP instructions to the system prompt: ${String(error && error.message ? error.message : error)}`)
    }
  }
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptService = (promptCtx && promptCtx.systemPrompt) || null
    syncPromptSection()
  })

  const definitions = [statusTool(settings, hooks), cliTool(settings), installTool(settings, hooks), surfaceTool(settings, hooks), bootstrapTool(settings, hooks)]
  ctx.effect(() => {
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(ctx.tools.register(definition))
      return () => {
        while (disposers.length > 0) {
          const dispose = disposers.pop()
          try { dispose?.() } catch { /* keep unloading the rest */ }
        }
      }
    } catch (error) {
      while (disposers.length > 0) { try { disposers.pop()?.() } catch { /* ignore */ } }
      throw error
    }
  }, 'dsh-rust-anything: rust-anything tools')

  // The MCP client owns a child process; start it with the plugin and stop it with the plugin.
  ctx.effect(() => {
    startClient().catch((error) => {
      runtime.lastError = String(error && error.message ? error.message : error)
      console.error(`[dsh-rust-anything] MCP client did not start: ${runtime.lastError}`)
    })
    return () => stopClient()
  }, 'dsh-rust-anything: mcp client')

  // ---- Web routes -------------------------------------------------------------------------
  const httpAuth = createHttpAuth(ctx, settings, statePaths(settings).tokenFile)
  ctx.inject(['webServer'], (webCtx) => {
    const route = (pathname, handler, label, options) => webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: pathname, handler: options ? guarded(handler, httpAuth, options) : guarded(handler, httpAuth) }),
      `dsh-rust-anything: ${label} route`,
    )
    route(TOKEN_ROUTE, tokenRouteHandler(httpAuth), 'token', { token: false })
    route(STATUS_ROUTE, statusRouteHandler(() => settings, hooks), 'status')
    route(SURFACE_ROUTE, surfaceRouteHandler(() => settings, hooks), 'surface')
    route(BOARD_ROUTE, boardRouteHandler(() => settings), 'board')
    route(INSTALL_ROUTE, installRouteHandler(() => settings, hooks), 'install')
    route(BOOTSTRAP_ROUTE, bootstrapRouteHandler(() => settings, hooks), 'bootstrap')
  })
}
