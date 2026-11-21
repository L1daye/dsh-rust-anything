// dsh-rust-anything — environment bootstrap.
//
// rust-anything itself ships as one prebuilt binary, so `analyze` / `map` / MCP tools work as soon
// as the CLI is installed. The rest of the loop (bridge → build → gate → bench, and record in the
// project's own language) needs toolchains that no npm package can sensibly carry: cargo, the MSVC
// linker, a modern Node/Python, wasm targets. `rust-anything doctor --json` already names every one
// of them and the command that fixes it; this module turns that into something the plugin can run:
// a plan (which checks to install for which kind of project), the exact commands per check, PATH
// refresh between steps, and a job log.
//
// Two deliberate refusals:
//   - `agents` is never installed. doctor's fix is `rust-anything setup`, which registers Claude
//     Code / Codex / Cursor / Gemini CLI / OpenCode — this Harness is the agent. Installing it here
//     would write config for tools that are not on the machine.
//   - `mcp server` is self-reported by the CLI we just ran, and is already "ok".

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()

const WINGET_FLAGS = ['--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']

/** rustup mirrors. static.rust-lang.org is frequently unusable from mainland China; rsproxy is the
 *  usual fix, and setting both variables also redirects rustup-init's own bootstrap download. */
export const MIRRORS = {
  official: {},
  // TUNA first: measured on a mainland-China link, rsproxy delivered the manifest but stalled
  // part-way through the components, while TUNA finished the toolchain in about two minutes.
  cn: {
    RUSTUP_DIST_SERVER: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    RUSTUP_UPDATE_ROOT: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  },
  rsproxy: {
    RUSTUP_DIST_SERVER: 'https://rsproxy.cn',
    RUSTUP_UPDATE_ROOT: 'https://rsproxy.cn/rustup',
  },
}

/** Plan presets: which checks a project of this kind actually needs. */
export const PLANS = {
  rust: ['cargo', 'cc'],
  ts: ['cargo', 'cc', 'node'],
  python: ['cargo', 'cc', 'python3'],
  go: ['cargo', 'cc', 'go'],
  ruby: ['cargo', 'cc', 'ruby'],
  java: ['cargo', 'cc', 'java', 'javac'],
  wasm: ['cargo', 'cc', 'wasm32-unknown-unknown', 'wasm-bindgen'],
  android: ['cargo', 'cc', 'kotlinc', 'Android Rust targets', 'Android NDK'],
  all: ['cargo', 'cc', 'node', 'python3', 'go', 'ruby', 'java', 'javac', 'php', 'dotnet', 'wasm32-unknown-unknown', 'wasm-bindgen', 'kotlinc', 'Android Rust targets', 'Android NDK'],
}

const VS_BUILD_TOOLS_OVERRIDE = [
  '--wait', '--quiet', '--norestart', '--nocache',
  '--add', 'Microsoft.VisualStudio.Workload.VCTools',
  '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '--includeRecommended',
].join(' ')

/**
 * One installable check. `winget` is the package id; `post` runs after the package lands (rustup
 * targets, cargo installs); `env` names a PATH entry the check needs.
 */
export const CHECKS = {
  cargo: {
    label: 'Rust toolchain (cargo, rustup)',
    why: 'bridge 生成的 crate 编不了；build / gate / bench 全部停摆',
    weight: 'small',
    // rustup-init is deterministic and does not depend on winget's Rust package behaviour.
    download: {
      url: 'https://win.rustup.rs/x86_64',
      file: 'rustup-init.exe',
      args: ['-y', '--default-host', 'x86_64-pc-windows-msvc', '--profile', 'minimal', '--no-modify-path'],
    },
    env: ['{home}\\.cargo\\bin'],
    ensureDefaultToolchain: true,
    post: [{ rustup: ['--version'] }],
  },
  cc: {
    label: 'C/C++ linker (MSVC Build Tools)',
    why: 'Windows 上 cargo 链接要 link.exe；没有它就是 cargo 装好了也编不过',
    weight: 'large',
    winget: 'Microsoft.VisualStudio.2022.BuildTools',
    wingetOverride: VS_BUILD_TOOLS_OVERRIDE,
  },
  node: {
    label: 'Node.js 22+',
    why: 'TS/JS 的 record / diff / bench 直接跑 .ts 源码，22.6+ 才原生支持',
    weight: 'small',
    winget: 'OpenJS.NodeJS',
  },
  python3: {
    label: 'Python 3.9+',
    why: 'Python 项目的 record / diff / bench',
    weight: 'small',
    // Direct from a CN mirror: winget's copy of this package stalled for 8 minutes on this network
    // (the download stopped growing part-way), while the mirror delivered 3 MB/s.
    direct: {
      url: 'https://mirrors.huaweicloud.com/python/3.13.0/python-3.13.0-amd64.exe',
      kind: 'exe',
      args: ['/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=0', 'Include_test=0', 'SimpleInstall=1'],
      path: ['{localappdata}\\Programs\\Python\\Python313', '{localappdata}\\Programs\\Python\\Python313\\Scripts'],
      alsoAs: 'python3',
      // machine scope: %LOCALAPPDATA%\Microsoft\WindowsApps holds a python3.exe Store alias that a
      // per-user PATH entry can never outrank
      scope: 'machine',
    },
    winget: 'Python.Python.3.13',
  },
  go: {
    label: 'Go 1.21+',
    why: 'Go 项目的 record / diff',
    weight: 'small',
    direct: {
      url: 'https://mirrors.aliyun.com/golang/go1.23.4.windows-amd64.zip',
      kind: 'zip',
      dest: 'go',
      path: ['{root:dest}\\go\\bin'],
    },
    winget: 'GoLang.Go',
  },
  ruby: {
    label: 'Ruby 3+',
    why: 'Ruby 项目的 record / diff',
    weight: 'small',
    // GitHub release assets run at ~29 KB/s here; the gh-proxy mirror of the same file measured
    // 918 KB/s. RubyInstaller is Inno Setup, so /VERYSILENT and /DIR work.
    direct: {
      url: 'https://gh-proxy.com/https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-3.4.1-1/rubyinstaller-3.4.1-1-x64.exe',
      kind: 'exe',
      args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/DIR={root:dest}'],
      dest: 'ruby',
      path: ['{root:dest}\\bin'],
      scope: 'machine',
    },
    winget: 'RubyInstallerTeam.RubyWithDevKit.3.4',
  },
  java: {
    label: 'JDK 17+',
    why: 'Java 项目的 record / diff',
    weight: 'small',
    direct: {
      url: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
      kind: 'zip',
      dest: 'jdk21',
      flatten: true,
      path: ['{root:dest}\\bin'],
      // machine scope: the machine PATH already holds Oracle's javapath (JDK 11), which a user
      // entry can never outrank
      scope: 'machine',
    },
    winget: 'EclipseAdoptium.Temurin.21.JDK',
  },
  javac: {
    label: 'javac 17+',
    why: '与 java 是同一套 JDK，装一次就够',
    weight: 'small',
    direct: {
      url: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
      kind: 'zip',
      dest: 'jdk21',
      flatten: true,
      path: ['{root:dest}\\bin'],
      // machine scope: the machine PATH already holds Oracle's javapath (JDK 11), which a user
      // entry can never outrank
      scope: 'machine',
    },
    winget: 'EclipseAdoptium.Temurin.21.JDK',
  },
  php: {
    label: 'PHP 8',
    why: 'PHP 项目只能走 app record / replay 与前门',
    weight: 'small',
    // Portable zip from the official Windows builds page (108 KB/s measured; winget's route stalls).
    direct: {
      url: 'https://windows.php.net/downloads/releases/latest/php-8.4-nts-Win32-vs17-x64-latest.zip',
      kind: 'zip',
      dest: 'php',
      path: ['{root:dest}'],
      scope: 'machine',
    },
    winget: 'PHP.PHP.8.4',
  },
  dotnet: {
    label: '.NET SDK 8',
    why: 'C# 项目只能走 app record / replay 与前门',
    weight: 'large',
    // The MS CDN measured 723 KB/s; the installer is silent and puts the SDK under Program Files.
    direct: {
      url: 'https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.404/dotnet-sdk-8.0.404-win-x64.exe',
      kind: 'exe',
      args: ['/install', '/quiet', '/norestart'],
      path: ['{programfiles}\\dotnet'],
      scope: 'machine',
    },
    winget: 'Microsoft.DotNet.SDK.8',
  },
  kotlinc: {
    label: 'Kotlin compiler (kotlinc)',
    why: 'Kotlin 项目（rust-anything 2.1 起支持）的 record / diff',
    weight: 'small',
    direct: {
      url: 'https://gh-proxy.com/https://github.com/JetBrains/kotlin/releases/download/v2.1.0/kotlin-compiler-2.1.0.zip',
      kind: 'zip',
      dest: 'kotlin',
      flatten: true,
      path: ['{root:dest}\\bin'],
      scope: 'machine',
    },
  },
  'Android NDK': {
    label: 'Android NDK',
    why: 'Android 目标要交叉编译；只有移植 Android 原生模块才需要',
    weight: 'large',
    direct: {
      url: 'https://dl.google.com/android/repository/android-ndk-r28-windows.zip',
      kind: 'zip',
      dest: 'ndk',
      flatten: true,
      path: [],
      // doctor finds the NDK through this variable (or --ndk), not through PATH
      env: { ANDROID_NDK_HOME: '{root:dest}' },
      scope: 'machine',
    },
  },
  'Android Rust targets': {
    label: 'Android Rust targets',
    why: 'aarch64-linux-android / armv7-linux-androideabi / x86_64-linux-android',
    weight: 'small',
    requires: ['cargo'],
    rustupTargets: ['aarch64-linux-android', 'armv7-linux-androideabi', 'x86_64-linux-android'],
  },
  'wasm32-unknown-unknown': {
    label: 'rustup target wasm32-unknown-unknown',
    why: 'wasm 桥需要；先有 cargo',
    weight: 'small',
    requires: ['cargo'],
    rustupTarget: 'wasm32-unknown-unknown',
  },
  'wasm-bindgen': {
    label: 'wasm-bindgen-cli',
    why: 'wasm 桥的胶水；版本要和 crate 的 wasm-bindgen 对齐，build 会告诉你确切版本',
    weight: 'large',
    requires: ['cargo'],
    cargoInstall: 'wasm-bindgen-cli',
  },
  'mcp server': { label: 'MCP server', why: '插件自己起的客户端，无需安装', skip: 'self' },
  agents: {
    label: 'Coding agents',
    why: 'doctor 的修法是 rust-anything setup，注册的是 Claude Code / Codex / Cursor / Gemini CLI / OpenCode——这个 Harness 自己就是 agent，所以不装',
    skip: 'agent',
  },
}

/** Read `rust-anything doctor --json` through the CLI, returning its checks array (or an error). */
/**
 * Detect the two checks doctor gets wrong on Windows.
 *   - cargo: doctor runs `cargo --version`, which fails when ~/.cargo/bin is not on PATH even
 *     though the toolchain is installed. "path-only" means installed but off PATH.
 *   - cc: doctor runs `cc --version`. MSVC has no `cc` binary, so that check can never pass on
 *     Windows; what `cargo build` needs is link.exe from the VS "VC Tools" component, and vswhere
 *     is the supported way to ask whether it is installed.
 * @returns {Promise<Record<string, 'ok'|'path-only'|'missing'>>}
 */
export async function localStatus(run, env) {
  const status = {}
  const cargoHome = path.join(HOME, '.cargo', 'bin', IS_WINDOWS ? 'cargo.exe' : 'cargo')
  if (onPath('cargo', env)) status.cargo = 'ok'
  else status.cargo = fs.existsSync(cargoHome) ? 'path-only' : 'missing'
  // Kotlin ships only .bat launchers on Windows; a direct spawn cannot run those, so the CLI's
  // `kotlinc` check stays red even with a working compiler. Detect it ourselves.
  if (onPath('kotlinc', env)) status.kotlinc = 'ok'
  if (IS_WINDOWS) {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (fs.existsSync(vswhere)) {
      const result = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { timeoutMs: 30_000, env })
      const found = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || null
      status.cc = found ? 'ok' : 'missing'
      if (found) status.ccPath = found
    } else {
      status.cc = 'missing'
    }
  }
  return status
}

export async function readDoctor(run, cli, env) {
  const result = await run(cli, ['doctor', '--json'], { timeoutMs: 120_000, env })
  try {
    const parsed = JSON.parse((result.stdout || '').trim())
    if (parsed && Array.isArray(parsed.checks)) return { ok: true, checks: parsed.checks }
  } catch { /* fall through */ }
  return { ok: false, checks: [], error: (result.stderr || result.stdout || '').trim().slice(0, 400) || `doctor exited ${result.code}` }
}

/**
 * Decide where rustup should download from. A 3-second probe of the official channel manifest is
 * enough to tell a working link from a throttled one: measured on a mainland-China line, the
 * official host delivered 873 KB in 18 s (~48 KB/s) both directly and through a local proxy, which
 * is a 70-minute toolchain, while TUNA finished the same toolchain in about two minutes.
 * @returns {Promise<'official'|'cn'>}
 */
export async function probeMirror(log = () => {}) {
  if (typeof fetch !== 'function') return 'cn'
  const url = 'https://static.rust-lang.org/dist/channel-rust-stable.toml'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-rust-anything' } })
    const text = await response.text()
    const seconds = Math.max((Date.now() - started) / 1000, 0.01)
    const kbps = Math.round(text.length / 1024 / seconds)
    log(`official rust dist: ${Math.round(text.length / 1024)} KB in ${seconds.toFixed(1)} s (~${kbps} KB/s)`)
    return kbps >= 100 ? 'official' : 'cn'
  } catch (error) {
    log('official rust dist did not answer within 5 s; using the CN mirror')
    return 'cn'
  } finally {
    clearTimeout(timer)
  }
}

/** Where a mirror name lands: 'auto' probes, everything else is explicit. */
export async function resolveMirror(name, log) {
  if (name && name !== 'auto') return MIRRORS[name] ? name : 'official'
  return probeMirror(log)
}

/**
 * Turn a plan name (or explicit ids) plus the doctor result into an ordered list of work items.
 * Order matters: rustup before rustup targets, everything before the multi-GB MSVC install.
 */
export function planFor({ plan, ids, checks, local }) {
  const known = local || {}
  const wanted = Array.isArray(ids) && ids.length ? ids.map(String) : (PLANS[plan] || PLANS.rust)
  const byId = new Map((checks || []).map((check) => [String(check.name), check]))
  const items = []
  const seen = new Set()
  for (const id of wanted) {
    if (seen.has(id)) continue
    seen.add(id)
    const spec = CHECKS[id]
    if (!spec) {
      items.push({ id, action: 'unknown', label: id, detail: `doctor 没有这一项，插件也没有它的安装方式` })
      continue
    }
    if (spec.skip) {
      items.push({ id, action: 'skip', label: spec.label, detail: spec.skip === 'self' ? '无需安装（本插件自带客户端）' : spec.why })
      continue
    }
    const localState = known[id]
    if (localState === 'ok') {
      const check = byId.get(id)
      items.push({
        id,
        action: 'ok',
        label: spec.label,
        detail: id === 'cc' && IS_WINDOWS && known.ccPath
          ? `MSVC 已装（${known.ccPath}）；doctor 的 cc 探针在 Windows 上永远不过，可以忽略`
          : (check && check.detail) || '已就绪',
      })
      continue
    }
    const check = byId.get(id)
    if (localState === 'path-only') {
      items.push({
        id,
        action: 'fixpath',
        label: spec.label,
        detail: '已装但不在 PATH 上（doctor 因此报 missing）',
        dirs: (spec.env || []).map(expand),
      })
      continue
    }
    if (check && check.status === 'ok') {
      items.push({ id, action: 'ok', label: spec.label, detail: check.detail || '已就绪' })
      continue
    }
    items.push({
      id,
      action: 'install',
      label: spec.label,
      detail: (check && check.detail) || spec.why,
      why: spec.why,
      weight: spec.weight || 'small',
      requires: spec.requires || [],
      doctorFix: check && check.fix ? String(check.fix) : null,
    })
  }
  const order = (item) => (item.id === 'cargo' ? 0 : item.weight === 'large' ? 2 : 1)
  return items.sort((a, b) => order(a) - order(b))
}

/** Refresh this process's PATH from the machine + user environment (winget/rustup add entries). */
export async function refreshPath(run, env) {
  if (!IS_WINDOWS) return env
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
  const result = await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30_000, env })
  const fresh = (result.stdout || '').trim()
  if (result.code !== 0 || !fresh) return env
  const seen = new Set()
  const parts = []
  for (const entry of fresh.split(';').concat((env.PATH || '').split(';'))) {
    const key = entry.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    parts.push(entry.trim())
  }
  return { ...env, PATH: parts.join(';') }
}

/**
 * Append directories to the user's persistent PATH (idempotent) and return an env carrying the
 * result, so a rustup installed with --no-modify-path still becomes usable by every later process.
 */
export async function ensureUserPath(run, env, dirs, prepend = false) {
  const wanted = (dirs || []).filter(Boolean)
  if (!IS_WINDOWS || wanted.length === 0) return env
  const literal = wanted.map((dir) => `'${String(dir).replace(/'/g, "''")}'`).join(',')
  const script = [
    `$wanted = @(${literal})`,
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "$list = @($current -split ';' | Where-Object { $_ -ne '' })",
    "foreach ($dir in $wanted) { if (-not ($list | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') })) { $list += $dir } }",
    "[Environment]::SetEnvironmentVariable('Path', ($list -join ';'), 'User')",
    "$list -join ';'",
  ].join('; ')
  const result = await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30_000, env })
  const text = (result.stdout || '').trim()
  if (result.code !== 0) throw new Error((result.stderr || text || 'could not update the user PATH').slice(0, 300))
  return { ...env, Path: text, PATH: text }
}

/**
 * Prepend directories to the *machine* PATH. Windows composes PATH as machine-then-user, so a
 * per-user entry can never outrank a machine one — and the machine PATH already holds
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`, whose python3.exe is a Store alias. A freshly installed
 * Python is therefore invisible to `python3` until it sits in front of that folder in the machine
 * PATH. Needs an elevated session, which the installer runs in.
 */
export async function ensureMachinePath(run, env, dirs) {
  const wanted = (dirs || []).filter(Boolean)
  if (!IS_WINDOWS || wanted.length === 0) return env
  const literal = wanted.map((dir) => `'${String(dir).replace(/'/g, "''")}'`).join(',')
  const script = [
    `$wanted = @(${literal})`,
    "$current = [Environment]::GetEnvironmentVariable('Path','Machine')",
    "$list = @($current -split ';' | Where-Object { $_ -ne '' })",
    "foreach ($dir in $wanted) { if (-not ($list | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') })) { $list = @($dir) + $list } }",
    "[Environment]::SetEnvironmentVariable('Path', ($list -join ';'), 'Machine')",
    "$list -join ';'",
  ].join('; ')
  const result = await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30_000, env })
  const text = (result.stdout || '').trim()
  if (result.code !== 0) throw new Error((result.stderr || text || 'could not update the machine PATH').slice(0, 300))
  return { ...env, Path: text, PATH: text }
}

/**
 * Re-read machine-scope environment variables. doctor finds the NDK through ANDROID_NDK_HOME, and
 * the harness process keeps the environment it started with — so a variable we set at install time
 * is invisible until the app restarts. Reading it per probe removes that restart.
 */
export async function refreshMachineEnv(run, env, names = []) {
  const wanted = (names || []).filter(Boolean)
  if (!IS_WINDOWS || wanted.length === 0) return env
  const script = wanted
    .map((name) => `"${name}=$([Environment]::GetEnvironmentVariable('${name}','Machine'))"`)
    .join('; ')
  const result = await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20_000, env })
  if (result.code !== 0) return env
  const next = { ...env }
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key && value) next[key] = value
  }
  return next
}

function expand(template) {
  return String(template).replace('{home}', HOME)
}

/** Look a program up on PATH only — no fallback to a well-known install directory. */
export function onPath(name, env) {
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* keep looking */ }
    }
  }
  return null
}

function toolPath(name, env) {
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* keep looking */ }
    }
  }
  for (const template of [`{home}\\.cargo\\bin\\${name}.exe`, `{home}\\.cargo\\bin\\${name}`]) {
    const candidate = expand(template)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* keep looking */ }
  }
  return null
}

/** Report the growing file every `everyMb` so a 700 MB download is not silent for an hour. */
function progressReporter(file, log, everyMb = 50) {
  let last = 0
  try { last = fs.statSync(file).size / (1024 * 1024) } catch { /* not created yet */ }
  const timer = setInterval(() => {
    try {
      const mb = fs.statSync(file).size / (1024 * 1024)
      if (mb - last >= everyMb) {
        last = mb
        log(`  鈥?${Math.round(mb)} MB downloaded`)
      }
    } catch { /* file briefly missing between rename and create */ }
  }, 5000)
  if (timer.unref) timer.unref()
  return () => clearInterval(timer)
}

async function downloadTo(url, file, run, env, log = () => {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // curl streams straight to disk and shows progress in the file size; fetch buffers the whole body
  // in memory, which for a 700 MB NDK looks exactly like a stall. Prefer curl when it exists.
  const curlFirst = onPath('curl', process.env) || (IS_WINDOWS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : null)
  if (curlFirst && fs.existsSync(curlFirst)) {
    // `-C -` resumes a partial file: a killed 700 MB download continues instead of restarting.
    let have = 0
    try { have = fs.existsSync(file) ? fs.statSync(file).size : 0 } catch { have = 0 }
    if (have > 0) log(`  resuming at ${Math.round(have / (1024 * 1024))} MB`)
    const args = ['-sS', '--fail', '--retry', '2', '--continue-at', '-', '--max-time', '7200', '-o', file, url]
    const stopReporting = progressReporter(file, log)
    const streamed = await run(curlFirst, args, { timeoutMs: 7_200_000, env })
    stopReporting()
    if (streamed.code === 0 && fs.existsSync(file) && fs.statSync(file).size > 1024) return fs.statSync(file).size
  }
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 dsh-rust-anything' } })
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(file, buffer)
      return buffer.length
    } catch (error) {
      // Some hosts reject Node's fetch (TLS chain or UA); curl.exe ships with Windows 10+ and
      // follows redirects the same way.
      const curl = onPath('curl', process.env) || (IS_WINDOWS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : null)
      if (!curl || !fs.existsSync(curl)) throw error
      const result = await run(curl, ['-sS', '--fail', '--max-time', '1800', '-o', file, url], { timeoutMs: 1_800_000, env })
      if (result.code !== 0) throw new Error(`curl exited ${result.code}: ${(result.stderr || '').trim().slice(0, 200)}`)
      return fs.statSync(file).size
    }
  }
  throw new Error('this Node build has no fetch and no curl fallback')
}

/**
 * Run one check's installation. Every command is explicit here — nothing is taken from doctor's
 * `fix` string at runtime, because that string is advice for a human, not a command line we should
 * execute blindly.
 */
/**
 * Install one check from a direct download (no winget): an .exe installer run silently, or a .zip
 * unpacked under the plugin data directory. Every mirror here was measured from a mainland-China
 * link: Huawei's Python mirror 3 MB/s and TUNA's Adoptium 4 MB/s, against 27 KB/s from
 * golang.google.cn and a winget download that stopped growing part-way.
 */
/** Node's spawn does not apply PATHEXT, so a bare `powershell` is ENOENT; always use the full path. */
function powershellBinary() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(system) ? system : 'powershell.exe'
}

/** tar ships with Windows 10+ and handles both .zip and .tar.gz; PATH is only the fallback. */
function tarBinary(env) {
  const system = IS_WINDOWS
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar'
  if (fs.existsSync(system)) return system
  return onPath('tar', env) || 'tar'
}

/** Set machine-scope environment variables (the NDK is discovered through ANDROID_NDK_HOME). */
export async function ensureMachineEnv(run, env, values) {
  const entries = Object.entries(values || {})
  if (!IS_WINDOWS || entries.length === 0) return env
  const script = entries
    .map(([key, value]) => `[Environment]::SetEnvironmentVariable('${key}', '${String(value).replace(/'/g, "''")}', 'Machine')`)
    .join('; ')
  const result = await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30_000, env })
  if (result.code !== 0) throw new Error((result.stderr || 'could not set the machine environment').slice(0, 300))
  return { ...env, ...Object.fromEntries(entries) }
}

async function installDirect(item, direct, context) {
  const { run, log, root, env } = context
  const cache = path.join(root, 'cache')
  fs.mkdirSync(cache, { recursive: true })
  const name = direct.url.split('/').pop().split('?')[0]
  const file = path.join(cache, name)
  const part = `${file}.part`
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    log(`${name} already cached`)
  } else {
    // Download to .part and rename only on success: an interrupted 700 MB download used to leave a
    // truncated zip that looked cached, so tar failed and the run fell through to winget.
    fs.rmSync(part, { force: true })
    const bytes = await downloadTo(direct.url, part, run, env, log)
    fs.renameSync(part, file)
    log(`downloaded ${name} (${Math.round(bytes / 1024)} KB)`)
  }
  const dest = direct.dest ? path.join(root, direct.dest) : null
  if (direct.kind === 'exe') {
    const args = (direct.args || []).map((arg) => arg.replace('{root:dest}', dest || ''))
    const result = await run(file, args, { timeoutMs: 900_000, env })
    log(`${name} exited ${result.code}`)
    if (result.code !== 0) throw new Error(`installer exited ${result.code}: ${(result.stderr || '').trim().slice(0, 300)}`)
  } else {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    const tar = tarBinary(env)
    if (!tar) throw new Error('no tar on PATH to unpack the archive')
    const unpack = await run(tar, ['-xf', file, '-C', dest], { timeoutMs: 600_000 })
    if (unpack.code !== 0) throw new Error(`tar failed: ${(unpack.stderr || '').trim().slice(0, 300)}`)
    if (direct.flatten) {
      const dirs = fs.readdirSync(dest, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      if (dirs.length === 1) {
        const inner = path.join(dest, dirs[0].name)
        for (const child of fs.readdirSync(inner)) fs.renameSync(path.join(inner, child), path.join(dest, child))
        try { fs.rmdirSync(inner) } catch { /* not empty, harmless */ }
      }
    }
    log(`unpacked into ${dest}`)
  }
  const dirs = (direct.path || []).map((entry) => entry
    .replace('{root:dest}', dest || '')
    .replace('{localappdata}', process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'))
    .replace('{programfiles}', process.env.ProgramFiles || 'C:\\\\Program Files'))
  if (direct.alsoAs) {
    // doctor (and rust-anything) look for python3; a Windows python install only ships python.exe.
    for (const dir of dirs) {
      const from = path.join(dir, `${direct.alsoAs === 'python3' ? 'python' : direct.alsoAs}.exe`)
      const to = path.join(dir, `${direct.alsoAs}.exe`)
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to) } catch { /* best effort */ }
    }
  }
  if (direct.env) {
    const values = Object.fromEntries(Object.entries(direct.env).map(([key, value]) => [
      key,
      String(value).replace('{root:dest}', dest || '').replace('{localappdata}', process.env.LOCALAPPDATA || ''),
    ]))
    const next = await ensureMachineEnv(run, env, values)
    log(`set ${Object.keys(values).join(', ')} = ${Object.values(values).join(', ')}`)
    if (!dirs.length) return next
  }
  if (dirs.length) {
    const next = direct.scope === 'machine'
      ? await ensureMachinePath(run, env, dirs)
      : await ensureUserPath(run, env, dirs, true)
    log(`PATH now starts with ${dirs[0]}`)
    return next
  }
  return env
}

async function installOne(item, context) {
  const { run, log, root, env, mirrorEnv } = context
  let current = env
  if (context.mirrorEnv && Object.keys(context.mirrorEnv).length) current = { ...current, ...context.mirrorEnv }
  const spec = CHECKS[item.id]
  if (spec.download) {
    const target = path.join(root, 'cache', spec.download.file)
    if (!fs.existsSync(target) || fs.statSync(target).size < 100_000) {
      const bytes = await downloadTo(spec.download.url, target, run, current, log)
      log(`downloaded ${spec.download.file} (${bytes} bytes)`)
    }
    const result = await run(target, spec.download.args, { timeoutMs: 900_000, env: current })
    log(`rustup-init exited ${result.code}`)
    if (result.code !== 0) throw new Error(`rustup-init failed: ${(result.stderr || '').trim().slice(0, 300)}`)
    current = await refreshPath(run, current)
    // `--no-modify-path` keeps rustup from touching PATH, so the directories the check declares have
    // to be added here. Without this the tool is installed but invisible to doctor on every later
    // probe — exactly what happened with cargo on a fresh machine.
    const declared = (spec.env || [])
      .map((dir) => path.join(HOME, String(dir).replace(/^\{home\}/i, '').replace(/^[\\/]+/, '')))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory()
        } catch {
          return false
        }
      })
    if (declared.length) current = await ensureUserPath(run, current, declared, true)
  }
  if (spec.direct) {
    try {
      current = await installDirect(item, spec.direct, { run, log, root, env: current })
      current = await refreshPath(run, current)
      spec.winget = spec.winget && false // direct succeeded; nothing left to fall back to
    } catch (error) {
      log(`direct install failed: ${String(error && error.message ? error.message : error)}` + (spec.winget ? '; falling back to winget' : ''))
      if (!spec.winget) throw error
    }
  }
  if (spec.winget) {
    // --source winget matters: with the default sources winget refreshes `msstore` first and, when
    // storeedgefd is unreachable, aborts with 0x8A15005E ("failed when searching source: msstore")
    // before it ever looks at the package. Pinning the community source avoids that.
    const args = ['install', '--id', spec.winget, '-e', '--source', 'winget', ...WINGET_FLAGS]
    if (spec.wingetOverride) args.push('--override', spec.wingetOverride)
    const winget = toolPath('winget', current) || 'winget'
    log(`winget install ${spec.winget}${spec.weight === 'large' ? ' (大型安装，几分钟到二十分钟)' : ''}`)
    const result = await run(winget, args, { timeoutMs: spec.weight === 'large' ? 2_700_000 : 1_200_000, env: current })
    log(`winget exited ${result.code}${result.stdout ? `: ${tidyToolOutput(result.stdout)}` : ''}`)
    if (result.code !== 0 && result.code !== -1978335189) {
      // 0x8A15002B = "already installed"; anything else is a real failure.
      throw new Error(`winget install ${spec.winget} exited ${result.code}: ${tidyToolOutput(result.stderr || result.stdout, 3).slice(0, 300)}`)
    }
    current = await refreshPath(run, current)
  }
  if (spec.ensureDefaultToolchain) {
    // A rustup-init that was interrupted (or that found rustup already present) can leave a
    // toolchain installed with no default set; `cargo --version` then fails with "no default".
    const rustup = toolPath('rustup', current)
    if (rustup) {
      const probe = await run(rustup, ['show', 'active-toolchain'], { timeoutMs: 60_000, env: current })
      if (probe.code !== 0) {
        const fix = await run(rustup, ['default', 'stable'], { timeoutMs: 600_000, env: current })
        log(`rustup default stable -> exit ${fix.code}`)
        if (fix.code !== 0) log((fix.stderr || '').trim().split(/\r?\n/).slice(-2).join(' '))
      }
    } else {
      log('rustup not found after installation; the toolchain may be incomplete')
    }
  }
  const targets = spec.rustupTargets || (spec.rustupTarget ? [spec.rustupTarget] : [])
  if (targets.length) {
    const rustup = toolPath('rustup', current)
    if (!rustup) throw new Error('rustup is missing; install cargo first')
    for (const target of targets) {
      const result = await run(rustup, ['target', 'add', target], { timeoutMs: 900_000, env: current })
      log(`rustup target add ${target} exited ${result.code}`)
      if (result.code !== 0) throw new Error((result.stderr || '').trim().slice(0, 300))
    }
  }
  if (spec.cargoInstall) {
    const cargo = toolPath('cargo', current)
    if (!cargo) throw new Error('cargo is missing; install cargo first')
    // `--locked` is what upstream recommends; the version that matters is the crate's, and
    // `build` names it, so the default install is only the first approximation.
    // crates.io is slow from here too; with the CN mirror selected, point cargo at rsproxy's sparse
    // index through a one-off --config file rather than editing the user's ~/.cargo/config.toml.
    const args = ['install', spec.cargoInstall, '--locked']
    if (mirrorEnv && mirrorEnv.RUSTUP_DIST_SERVER) {
      const cfgPath = path.join(root, 'cargo-cn.toml')
      try {
        fs.writeFileSync(cfgPath, '[source.crates-io]\nreplace-with = "cn"\n\n[source.cn]\nregistry = "sparse+https://rsproxy.cn/index/"\n')
        args.push('--config', cfgPath)
      } catch { /* fall back to crates.io */ }
    }
    const result = await run(cargo, args, { timeoutMs: 2_700_000, env: current })
    log(`cargo install ${spec.cargoInstall} exited ${result.code}`)
    if (result.code !== 0) throw new Error((result.stderr || '').trim().slice(0, 400))
  }
  for (const post of spec.post || []) {
    for (const [name, args] of Object.entries(post)) {
      const binary = toolPath(name, current)
      if (!binary) continue
      const result = await run(binary, args, { timeoutMs: 60_000, env: current })
      log(`${name} ${args.join(' ')} -> ${(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || `exit ${result.code}`}`)
    }
  }
  return current
}

export function bootstrapStateFile(root) {
  return path.join(root, 'bootstrap.json')
}

/** A dry run prints exactly what would run, and touches nothing. */
/** winget writes a spinner (` \ | / - `) plus long progress; keep the lines a human can act on. */
export function tidyToolOutput(text, limit = 4) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\\|/\-\s]+$/.test(line) && !/^\d+%$/.test(line))
  return lines.slice(-limit).join(' | ')
}

export function describeItem(item) {
  const spec = CHECKS[item.id]
  if (!spec || !spec.label) return `${item.id}: unknown`
  if (spec.download) {
    return `download ${spec.download.url} -> <root>/cache/${spec.download.file}; run ${spec.download.file} ${spec.download.args.join(' ')}`
  }
  if (spec.direct) {
    return spec.direct.kind === 'exe'
      ? `download ${spec.direct.url} -> <root>/cache; run ${spec.direct.args.join(' ')}`
      : `download ${spec.direct.url} -> <root>/cache; unpack into ${spec.direct.dest}${spec.direct.flatten ? ' (flattened)' : ''}`
  }
  if (spec.winget) {
    return `winget install --id ${spec.winget} -e --source winget ${WINGET_FLAGS.join(' ')}${spec.wingetOverride ? ` --override "${spec.wingetOverride}"` : ''}`
  }
  const targets = spec.rustupTargets || (spec.rustupTarget ? [spec.rustupTarget] : [])
  if (targets.length) return `rustup target add ${targets.join(' ')}`
  if (spec.cargoInstall) return `cargo install ${spec.cargoInstall} --locked`
  return `${item.id}: nothing to run`
}

/**
 * @param {{run: Function, cli?: string, root: string, plan?: string, ids?: string[],
 *          dryRun?: boolean, env?: object, log?: Function, signal?: AbortSignal}} options
 */
export async function runBootstrap(options) {
  const log = options.log || (() => {})
  const env = options.env || process.env
  const started = Date.now()
  const before = options.checks ? { ok: true, checks: options.checks } : await readDoctor(options.run, options.cli, options.env)
  const local = options.local || await localStatus(options.run, options.env || process.env)
  const items = planFor({ plan: options.plan, ids: options.ids, checks: before.checks, local })
  const result = {
    ok: true,
    dryRun: Boolean(options.dryRun),
    plan: options.plan || (options.ids ? 'custom' : 'rust'),
    mirror: options.mirror || 'auto',
    startedAt: new Date(started).toISOString(),
    items: [],
    doctorBefore: before.ok ? summarize(before.checks, options.local) : { error: before.error },
    doctorAfter: null,
    ms: 0,
  }
  if (options.dryRun) {
    for (const item of items) {
      result.items.push({ ...item, command: item.action === 'install' ? describeItem(item) : null })
    }
    result.ms = Date.now() - started
    return result
  }
  const mirrorName = await resolveMirror(options.mirror, log)
  const mirrorEnv = MIRRORS[mirrorName] || MIRRORS.official
  if (options.proxy) {
    mirrorEnv.HTTP_PROXY = options.proxy
    mirrorEnv.HTTPS_PROXY = options.proxy
    mirrorEnv.http_proxy = options.proxy
    mirrorEnv.https_proxy = options.proxy
  }
  let current = { ...env, ...mirrorEnv }
  for (const item of items) {
    if (item.action === 'fixpath') {
      const at = Date.now()
      try {
        current = await ensureUserPath(options.run, current, item.dirs || [])
        current = await refreshPath(options.run, current)
        log(`PATH updated with ${(item.dirs || []).join(', ')}`)
        result.items.push({ ...item, status: 'fixed', ms: Date.now() - at })
      } catch (error) {
        result.items.push({ ...item, status: 'failed', error: String(error && error.message ? error.message : error) })
        result.ok = false
      }
      continue
    }
    if (item.action !== 'install') {
      result.items.push({ ...item, status: item.action === 'ok' ? 'ok' : 'skipped' })
      continue
    }
    if (options.signal && options.signal.aborted) {
      result.items.push({ ...item, status: 'aborted' })
      result.ok = false
      break
    }
    log(`--- ${item.id}: ${item.label}`)
    const at = Date.now()
    try {
      current = await installOne(item, { run: options.run, log, root: options.root, env: current, mirrorEnv })
      result.items.push({ ...item, status: 'installed', ms: Date.now() - at })
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      log(`FAILED ${item.id}: ${message}`)
      result.items.push({ ...item, status: 'failed', error: message, ms: Date.now() - at })
      result.ok = false
    }
  }
  if (result.ok && options.cli) {
    const after = await readDoctor(options.run, options.cli, current)
    result.doctorAfter = after.ok ? summarize(after.checks, local) : { error: after.error }
  }
  result.ms = Date.now() - started
  return result
}

/**
 * The bottom line of the env card. It must agree with the rows above it, so the two checks doctor
 * gets wrong on Windows are handled the same way here: `cc` is satisfied by an installed MSVC
 * (vswhere), and the coding-agent / MCP-server checks are never installed by this plugin.
 */
export const NEVER_INSTALLED = new Set(['agents', 'mcp server'])

/**
 * Newer rust-anything builds list the agent targets individually (`Claude Code mcp`, `Gemini CLI
 * skill`, …) instead of one `agents` row. They are the same thing: registering this CLI into another
 * coding agent. This plugin never installs them, so they must not look actionable.
 */
const AGENT_TARGET = /^(Claude Code|Codex|Cursor|Gemini CLI|OpenCode|Qwen|Cline|Windsurf|Aider)\b/i

export function neverInstalled(name) {
  return NEVER_INSTALLED.has(name) || AGENT_TARGET.test(String(name))
}

export function summarize(checks, local = {}) {
  const info = { ok: 0, total: checks.length, stillMissing: [], skipped: [] }
  for (const check of checks) {
    if (check.status === 'ok') {
      info.ok += 1
      continue
    }
    if (neverInstalled(check.name)) {
      info.skipped.push(`${check.name}（不装）`)
      continue
    }
    if (check.name === 'cc' && local.cc === 'ok') {
      info.ok += 1
      info.skipped.push('cc（MSVC 已装，doctor 的 cc 探针在 Windows 上不适用）')
      continue
    }
    if (check.name === 'cargo' && local.cargo === 'path-only') {
      info.ok += 1
      info.skipped.push('cargo（已装，仅缺 PATH）')
      continue
    }
    info.stillMissing.push(`${check.name}${check.required ? ' (required)' : ` (${check.status})`}`)
  }
  return info
}
