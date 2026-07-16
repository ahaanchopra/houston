#!/usr/bin/env bash
# houston installer — curl -fsSL https://raw.githubusercontent.com/ahaanchopra/houston/main/install.sh | bash
#
# What it does (all under YOUR home, no sudo):
#   1. checks node >= 22, git, and the claude CLI
#   2. clones (or updates) the repo into ~/houston   [override: HOUSTON_DIR]
#   3. npm install + build
#   4. symlinks `houston` and `houston-mcp` into ~/.local/bin   [override: HOUSTON_BIN_DIR]
#   5. registers the MCP server with Claude Code   [skip: HOUSTON_NO_MCP=1]
set -euo pipefail

REPO_SLUG="${HOUSTON_REPO:-ahaanchopra/houston}"
REPO_URL="https://github.com/${REPO_SLUG}.git"
DIR="${HOUSTON_DIR:-$HOME/houston}"
BIN_DIR="${HOUSTON_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[36m[houston]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[houston]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[houston]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. prerequisites ────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git not found — install Xcode command line tools first: xcode-select --install"
command -v node >/dev/null 2>&1 || fail "node not found — houston needs Node 22+. Install from https://nodejs.org or: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $NODE_MAJOR is too old — houston needs Node 22+. Upgrade: brew install node"
command -v claude >/dev/null 2>&1 || warn "claude CLI not found on PATH — houston monitors Claude Code sessions, install it first (https://claude.com/claude-code). Continuing anyway."

# ── 2. get the code ─────────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "updating existing install in $DIR"
  git -C "$DIR" pull --ff-only || warn "git pull failed (local changes?) — building whatever is checked out"
else
  say "cloning into $DIR"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi

# ── 3. build ────────────────────────────────────────────────────────────────
cd "$DIR"
say "installing dependencies (npm)…"
npm install --no-fund --no-audit --loglevel=error
say "building…"
npm run build >/dev/null
# build stamp: `houston update` uses this to know dist/ matches HEAD
git -C "$DIR" rev-parse HEAD > "$DIR/dist/.build-commit" 2>/dev/null || true

# ── 4. put houston on PATH (no sudo — uses ~/.local/bin like the claude CLI) ─
mkdir -p "$BIN_DIR"
chmod +x bin/houston.js bin/houston-mcp.js
ln -sf "$DIR/bin/houston.js" "$BIN_DIR/houston"
ln -sf "$DIR/bin/houston-mcp.js" "$BIN_DIR/houston-mcp"
say "linked $BIN_DIR/houston"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to ~/.zshrc:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ── 5. register the MCP server so Claude can see your fleet ─────────────────
if [ "${HOUSTON_NO_MCP:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
  say "registering the houston MCP server with Claude Code…"
  node dist/tui/index.js setup || warn "MCP registration failed — run 'houston setup' manually later"
else
  say "skipping MCP registration (run 'houston setup' when ready)"
fi

say "✓ installed — open a terminal and run: houston"
say "  one-shot status: houston --snapshot   ·   uninstall: rm $BIN_DIR/houston $BIN_DIR/houston-mcp && claude mcp remove houston -s user"
