// Tests for install.ps1 — the one part of the plugin that touches a user's profile and therefore the
// one part with no other safety net. It drives the real script against a throwaway DSH home: the
// dry run asserts the decisions, the real run asserts the outcome, and -Uninstall asserts the way
// back.
//
// Windows only (the script is PowerShell + profile paths), so other platforms skip cleanly.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'install.ps1')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

if (process.platform !== 'win32') {
  console.log('\ninstalltest: skipped (install.ps1 is Windows only)')
  process.exit(0)
}

const shell = process.env.PWSH || 'pwsh'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ra-install-'))

function makeHome(name, { bundles = [], bridge = null } = {}) {
  const home = path.join(root, name)
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    `${JSON.stringify({ name: 'desktop-profile', dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
  if (bridge) {
    const dataDir = path.join(home, 'plugins-data', 'rust-anything')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'bridge.json'), `${JSON.stringify(bridge)}\n`)
  }
  return home
}

function runInstaller(home, extraArgs = []) {
  const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-DshHome', home, ...extraArgs], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` }
}

// ---- 1. dry run on a clean profile ------------------------------------------------------------
{
  const home = makeHome('clean')
  const { code, out } = runInstaller(home, ['-DryRun'])
  check('dry run exits 0', code === 0, `exit ${code}`)
  check('dry run finds the package folder', /source\s*:\s*.*dsh-rust-anything\s*$/m.test(out.trim()), out.split('\n').find((line) => line.includes('source')) || '')
  check('dry run reports the copy target', out.includes('[dry] would copy package ->'))
  check('dry run would register the bundle', out.includes("[dry] would append 'dsh-rust-anything' to dsh.profile.bundles"))
  check('dry run would seed the plan surface', /\[dry\] would write .*bridge\.json with 5 allow patterns/.test(out))
  check('dry run touches nothing', !fs.existsSync(path.join(home, 'profiles', 'desktop', 'node_modules')))
}

// ---- 2. an existing bridge.json is never overwritten -----------------------------------------
{
  const home = makeHome('has-bridge', { bridge: { enabled: true, allow: ['analyze'] } })
  const { out } = runInstaller(home, ['-DryRun'])
  check('an existing surface is left alone', out.includes('bridge.json already exists'))
  const kept = JSON.parse(fs.readFileSync(path.join(home, 'plugins-data', 'rust-anything', 'bridge.json'), 'utf8'))
  check('the existing allow list survives', kept.allow.length === 1 && kept.allow[0] === 'analyze', JSON.stringify(kept.allow))
}

// ---- 3. a profile that already lists the bundle ----------------------------------------------
{
  const home = makeHome('has-bundle', { bundles: ['dsh-rust-anything'] })
  const { out } = runInstaller(home, ['-DryRun'])
  check('a registered bundle is not appended twice', out.includes('bundle already listed in dsh.profile.bundles'))
}

// ---- 4. a real install, then the way back ----------------------------------------------------
{
  const home = makeHome('real')
  const profile = path.join(home, 'profiles', 'desktop')
  const target = path.join(profile, 'node_modules', 'dsh-rust-anything')

  const install = runInstaller(home)
  check('real install exits 0', install.code === 0, `exit ${install.code}`)
  check('the package lands in node_modules', fs.existsSync(path.join(target, 'host', 'index.js')))
  check('the entry point is there', fs.existsSync(path.join(target, 'client.js')))
  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  check('the profile lists the bundle', (pkg.dsh?.profile?.bundles || []).includes('dsh-rust-anything'), JSON.stringify(pkg.dsh?.profile?.bundles))
  const bridge = JSON.parse(fs.readFileSync(path.join(home, 'plugins-data', 'rust-anything', 'bridge.json'), 'utf8'))
  check('the surface is seeded as plan (5 tools)', bridge.enabled === true && bridge.allow.length === 5, JSON.stringify(bridge.allow))

  // A second install must move the previous copy aside instead of deleting it.
  const again = runInstaller(home)
  const backups = fs.readdirSync(path.join(profile, 'node_modules')).filter((name) => name.startsWith('dsh-rust-anything.bak-'))
  check('a re-install keeps a .bak copy', again.code === 0 && backups.length >= 1, backups.join(','))

  const uninstall = runInstaller(home, ['-Uninstall'])
  check('uninstall exits 0', uninstall.code === 0, `exit ${uninstall.code}`)
  check('the package folder is gone', !fs.existsSync(target))
  const after = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  check('the bundle entry is gone', !(after.dsh?.profile?.bundles || []).includes('dsh-rust-anything'), JSON.stringify(after.dsh?.profile?.bundles))
  check('the data folder survives', fs.existsSync(path.join(home, 'plugins-data', 'rust-anything')))
}

fs.rmSync(root, { recursive: true, force: true })

if (failures) {
  console.log(`\ninstalltest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ninstalltest: all checks passed')