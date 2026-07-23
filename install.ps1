# houston installer for Windows — run in PowerShell:
#   irm https://raw.githubusercontent.com/ahaanchopra/houston/main/install.ps1 | iex
#
# What it does (all under YOUR user profile, no admin):
#   1. checks node >= 22, git, and the claude CLI
#   2. clones (or updates) the repo into ~\houston   [override: $env:HOUSTON_DIR]
#   3. npm install + build
#   4. writes houston.cmd / houston-mcp.cmd shims into the npm global bin
#      (%APPDATA%\npm — already on PATH for every Node install)   [override: $env:HOUSTON_BIN_DIR]
#   5. registers the MCP server with Claude Code   [skip: $env:HOUSTON_NO_MCP = "1"]
$ErrorActionPreference = 'Stop'

function Say([string]$msg)  { Write-Host "[houston] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[houston] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "[houston] $msg" -ForegroundColor Red; exit 1 }

$repoSlug = if ($env:HOUSTON_REPO) { $env:HOUSTON_REPO } else { 'ahaanchopra/houston' }
$repoUrl  = "https://github.com/$repoSlug.git"
$dir      = if ($env:HOUSTON_DIR) { $env:HOUSTON_DIR } else { Join-Path $env:USERPROFILE 'houston' }
$binDir   = if ($env:HOUSTON_BIN_DIR) { $env:HOUSTON_BIN_DIR } else { Join-Path $env:APPDATA 'npm' }

# -- 1. prerequisites ---------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue))  { Fail 'git not found - install from https://git-scm.com first' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node not found - houston needs Node 22+. Install from https://nodejs.org' }
# parse `node --version` in PowerShell itself: passing quoted JS through the native-arg
# boundary loses the embedded quotes in Windows PowerShell 5.1 (split(".") became split(.))
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node $nodeMajor is too old - houston needs Node 22+. Upgrade at https://nodejs.org" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Warn 'claude CLI not found on PATH - houston monitors Claude Code sessions, install it first (https://claude.com/claude-code). Continuing anyway.' }

# -- 2. get the code ----------------------------------------------------------
if (Test-Path (Join-Path $dir '.git')) {
  Say "updating existing install in $dir"
  git -C $dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Warn 'git pull failed (local changes?) - building whatever is checked out' }
} else {
  Say "cloning into $dir"
  git clone --depth 1 $repoUrl $dir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
}

# -- 3. build -----------------------------------------------------------------
# npm.cmd, NOT bare npm: PowerShell resolves bare `npm` to npm.ps1, which the default
# Restricted execution policy refuses to load; the .cmd shim is exempt from policy
Set-Location $dir
Say 'installing dependencies (npm)...'
npm.cmd install --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
Say 'building...'
npm.cmd run build | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'build failed' }
# build stamp: `houston update` uses this to know dist/ matches HEAD
git -C $dir rev-parse HEAD | Set-Content (Join-Path $dir 'dist\.build-commit') -ErrorAction SilentlyContinue

# -- 4. put houston on PATH (cmd shims - work from PowerShell AND cmd) --------
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$houstonJs = Join-Path $dir 'bin\houston.js'
$mcpJs     = Join-Path $dir 'bin\houston-mcp.js'
Set-Content (Join-Path $binDir 'houston.cmd')     "@node `"$houstonJs`" %*"
Set-Content (Join-Path $binDir 'houston-mcp.cmd') "@node `"$mcpJs`" %*"
Say "linked $binDir\houston.cmd"
if (($env:Path -split ';') -notcontains $binDir) {
  Warn "$binDir is not on your PATH - add it in System Settings > Environment Variables"
}

# -- 5. register the MCP server so Claude can see your fleet ------------------
if ($env:HOUSTON_NO_MCP -ne '1' -and (Get-Command claude -ErrorAction SilentlyContinue)) {
  Say 'registering the houston MCP server with Claude Code...'
  node (Join-Path $dir 'dist\tui\index.js') setup
  if ($LASTEXITCODE -ne 0) { Warn "MCP registration failed - run 'houston setup' manually later" }
} else {
  Say "skipping MCP registration (run 'houston setup' when ready)"
}

Say 'installed - open PowerShell or cmd and run: houston'
Say "  one-shot status: houston --snapshot   -   uninstall: del $binDir\houston*.cmd; claude mcp remove houston -s user"
