# install.ps1 — drop dsh-rust-anything into a DSH profile.
#
# Usage:
#   .\install.ps1                    # default profile: desktop
#   .\install.ps1 -ProfileName web
#   .\install.ps1 -DryRun            # print the plan, change nothing
#   .\install.ps1 -Uninstall         # remove it again (bundle entry + package folder)
#   .\install.ps1 -Bootstrap rust    # also install the toolchains rust-anything needs
#                                    #   (cargo + MSVC linker), driven by `doctor --json`
#   .\install.ps1 -Bootstrap ts -BootstrapDryRun   # print the commands, install nothing
#
# What it does, in order:
#   1. copies .\dsh-rust-anything  ->  <profile>\node_modules\dsh-rust-anything
#      (an existing copy is renamed to .bak-<timestamp>, not deleted)
#   2. adds "dsh-rust-anything" to <profile>\package.json  dsh.profile.bundles
#   3. seeds <DSH_HOME>\plugins-data\rust-anything\bridge.json from bridge.plan.json
#      (only when absent: an existing surface choice is never overwritten)
#   4. reports the CLI and skill state; the CLI itself is installed by the ra_install tool
#      (or by the install button on the Rust Anything page)
#
# Nothing here touches dsh-purge, the harness install directory, or any other plugin.

[CmdletBinding()]
param(
  [string]$ProfileName = 'desktop',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$DryRun,
  [switch]$Uninstall,
  [ValidateSet('', 'rust', 'ts', 'python', 'go', 'ruby', 'java', 'wasm', 'all')]
  [string]$Bootstrap = '',
  [switch]$BootstrapDryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# The package lives either next to this script (repo root layout) or in a `dsh-rust-anything/`
# subfolder (the older layout); accept both.
$src  = if (Test-Path (Join-Path $here 'host\index.js')) { $here } else { Join-Path $here 'dsh-rust-anything' }
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$pkgJson    = Join-Path $profileDir 'package.json'
$target     = Join-Path $profileDir 'node_modules\dsh-rust-anything'
$dataDir    = Join-Path $DshHome 'plugins-data\rust-anything'
$skillDir   = Join-Path $DshHome 'skills\rust-anything'
$stamp      = Get-Date -Format 'yyyyMMddHHmmss'

function Say($m) { Write-Host $m }

Say "== dsh-rust-anything =="
Say "   profile : $profileDir"
Say "   source  : $src"

if (-not (Test-Path $pkgJson)) {
  throw "profile not found: $pkgJson — run the DSH app once so it creates the profile, or pass -ProfileName"
}

# --- uninstall ---------------------------------------------------------------
if ($Uninstall) {
  $pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
  $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-rust-anything' }
  if ($DryRun) {
    Say "   [dry] would drop 'dsh-rust-anything' from dsh.profile.bundles and remove $target"
    return
  }
  Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
  $pkg.dsh.profile.bundles = @($bundles)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgJson, ($pkg | ConvertTo-Json -Depth 32), $utf8NoBom)
  if (Test-Path $target) { Move-Item $target "$target.bak-$stamp" }
  Say "   removed the bundle entry and moved the package to $target.bak-$stamp"
  Say "   left untouched: $dataDir (bridge.json, install.json) and $skillDir"
  return
}

if (-not (Test-Path (Join-Path $src 'host\index.js'))) {
  throw "package missing: $src\host\index.js not found — run this script from inside the extracted archive"
}

# --- 1. copy the package -----------------------------------------------------
if ($DryRun) {
  Say "   [dry] would copy package -> $target (existing renamed .bak-$stamp)"
} else {
  if (Test-Path $target) {
    $old = "$target.bak-$stamp"
    Move-Item $target $old
    Say "   moved the previous copy to $old"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item $src $target -Recurse -Force
  Say "   copied the package into place"
}

# --- 2. register the bundle --------------------------------------------------
$pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
if (-not $pkg.dsh)         { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) {
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -contains 'dsh-rust-anything') {
  Say "   bundle already listed in dsh.profile.bundles"
} else {
  if ($DryRun) {
    Say "   [dry] would append 'dsh-rust-anything' to dsh.profile.bundles"
  } else {
    Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
    $pkg.dsh.profile.bundles = @($bundles + 'dsh-rust-anything')
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pkgJson, ($pkg | ConvertTo-Json -Depth 32), $utf8NoBom)
    Say "   appended 'dsh-rust-anything' to dsh.profile.bundles (backup: package.json.bak-$stamp)"
  }
}

# --- 3. seed the tool surface ------------------------------------------------
$bridgeFile = Join-Path $dataDir 'bridge.json'
# The seed is optional: a repository without bridge.plan.json just keeps the plugin's default surface.
$seedFile = Join-Path $here 'bridge.plan.json'
$seed = $null
if (Test-Path $seedFile) {
  $seed = Get-Content $seedFile -Raw | ConvertFrom-Json
  $seed.updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
if (-not $seed) {
  Say "   no bridge.plan.json next to install.ps1 - tool surface left at its default"
} elseif (Test-Path $bridgeFile) {
  Say "   bridge.json already exists — left untouched (delete it to re-seed the 'plan' surface)"
} elseif ($DryRun) {
  Say "   [dry] would write $bridgeFile with $($seed.allow.Count) allow patterns"
} else {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($bridgeFile, ($seed | ConvertTo-Json -Depth 8), $utf8NoBom)
  Say "   wrote $bridgeFile ($($seed.allow.Count) allow patterns = 'plan' surface)"
}


# --- 5. report ---------------------------------------------------------------
$exe = Join-Path $dataDir 'bin\rust-anything.exe'
$found = @()
if (Test-Path $exe) { $found += $exe }
if (Test-Path $dataDir) {
  Get-ChildItem $dataDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $candidate = Join-Path $_.FullName 'rust-anything.exe'
    if (Test-Path $candidate) { $found += $candidate }
  }
}
$onPath = (Get-Command rust-anything -ErrorAction SilentlyContinue)
Say ''
Say "   CLI      : $(if ($found.Count) { ($found | Select-Object -First 1) } elseif ($onPath) { $onPath.Source } else { 'not installed yet — call ra_install after restart (or press 安装 on the page)' })"
$bridgeFile = Join-Path $dataDir 'bridge.json'
if (Test-Path $bridgeFile) {
  $b = Get-Content $bridgeFile -Raw | ConvertFrom-Json
  $allow = if ($b.allow.Count) { $b.allow -join ',' } else { 'every tool' }
  Say "   surface  : enabled=$($b.enabled), allow=$allow"
}
Say "   skill    : $(if (Test-Path (Join-Path $skillDir 'SKILL.md')) { $skillDir } else { 'installed on first boot into ' + $skillDir })"
Say ''
# --- 6. optional: install the toolchains rust-anything needs -------------------
if ($Bootstrap) {
  $cli = $null
  $candidates = @((Join-Path $dataDir 'bin\rust-anything.exe'))
  Get-ChildItem $dataDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $candidates += (Join-Path $_.FullName 'rust-anything.exe') }
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { $cli = $candidate; break } }
  if (-not $cli -and $onPath) { $cli = $onPath.Source }
  $nodeExe = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeExe) {
    Say ""
    Say "   bootstrap skipped: node is not on PATH, so host\bootstrap-cli.mjs cannot run"
  } else {
    Say ""
    Say "   bootstrap: plan $Bootstrap"
    $bootstrapArgs = @((Join-Path $src 'host\bootstrap-cli.mjs'), '--plan', $Bootstrap, '--root', $dataDir)
    if ($cli) { $bootstrapArgs += @('--cli', $cli) }
    if ($BootstrapDryRun) { $bootstrapArgs += '--dry-run' }
    & $nodeExe.Source @bootstrapArgs
    Say "   bootstrap exit code: $LASTEXITCODE"
  }
}

Say "Next: restart DSH Desktop, open Plugins and make sure 'Rust Anything' is enabled."
Say "      Sidebar gets a Rust Anything page; the composer gets a tool-surface chip"
Say "      (关 / 规划 / 移植 / 全部)."
