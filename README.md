# houston 🚀

**Mission control for vibe coders** — one terminal that sees, summarizes, and steers every Claude Code session on your Mac.

You run Claude Code in three Terminal tabs, each on a different task. Houston is the fourth tab: a live dashboard showing what every session has done, what's left, which ones finished, and which are stuck waiting for you — with one-key git actions so "save my work to GitHub" is a button, not a ritual.

```
 HOUSTON mission control              ● 2 busy  ○ 1 idle  ✕ 1 ended  ctx max 261k  11:57 pm
╭──────────────────────────────────╮ ╭──────────────────────────────────╮ ╭─ recent prompts ────────────╮
│ ● Fixing login flow              │ │ ○ Washing machine page           │ │ 11:35 pm add validation to… │
│ ⠋ working                        │ │ ○ your turn                      │ │ 11:05 pm why is the deploy… │
│ ███░░░░░░░░░ 26% (261k/1.0M)     │ │ █░░░░░░░░░░░ 8% (16k/200k)      │ │ 10:57 pm build me a landin… │
│ ± 3 files +42/-7  3s ago         │ │ smart-home  12m ago              │ ╰─────────────────────────────╯
╰──────────────────────────────────╯ ╰──────────────────────────────────╯
 [enter]details [c]ommit [p]ush [v]save-version [s]ummarize [n]ew [j]ump [g]raph [?]help [q]uit
```

## Install

One line, no sudo:

```bash
curl -fsSL https://ahaanchopra.com/houston | bash
```

(That URL 302-redirects to this repo's `install.sh`; fetching it straight from GitHub works too:)

```bash
curl -fsSL https://raw.githubusercontent.com/ahaanchopra/houston/main/install.sh | bash
```

The installer checks Node 22+, clones to `~/houston`, builds, links `houston` into `~/.local/bin` (same place the `claude` CLI lives), and registers the MCP server with Claude Code. Re-run the same command any time to **update**. Options via env vars: `HOUSTON_DIR` (install location), `HOUSTON_BIN_DIR` (bin location), `HOUSTON_NO_MCP=1` (skip MCP registration).

Manual install, if you prefer to read before you run:

```bash
git clone https://github.com/ahaanchopra/houston.git ~/houston
cd ~/houston && npm install && npm run build
ln -sf ~/houston/bin/houston.js ~/.local/bin/houston
ln -sf ~/houston/bin/houston-mcp.js ~/.local/bin/houston-mcp
houston setup     # registers the MCP server so Claude itself can see your fleet
```

Uninstall: `rm ~/.local/bin/houston ~/.local/bin/houston-mcp && claude mcp remove houston -s user && rm -rf ~/houston`

## Run

Open any terminal and run `houston`. Your Claude sessions appear as cards the moment they start.

- `houston` — the dashboard
- `houston --snapshot` — one-shot text status (for scripts / non-TTY)
- `houston update` — pull the latest version and rebuild (the dashboard also shows an "⬆ update available" badge and accepts `update` as a command)
- `houston setup` — (re)register the MCP server with Claude Code

## Commands, not keybindings

You control Houston by **typing words** — `commit`, `push`, `version`, `summarize`, `new`, `stop`, `update`, `help`, `quit` — and pressing Enter. Short prefixes work (`com` → commit), single-letter aliases still exist for speed, arrows/Tab move between session cards, and Enter on an empty command bar opens the focused session.

## What it does

| | |
|---|---|
| **Live session cards** | busy / idle / ended, AI-generated titles, context-window meter, files touched |
| **Attention alerts** | macOS banner when a long-running session finishes or needs your input; "possibly waiting on you?" badge when a busy session stops writing its transcript |
| **AI summaries** (`summarize`) | cheap Haiku call, cached: what's DONE, what REMAINS, current focus, blockers |
| **Commit** (`commit`) | stages everything, Haiku writes the message, you edit & approve. Blocks `.env`/keys/oversized files. Offers `git init` + .gitignore on non-repos |
| **Push** (`push`) | plain-English errors ("not connected to GitHub yet → run gh repo create …") |
| **Save version** (`version`) | commit-if-dirty + annotated tag `save-YYYYMMDD-HHMMSS` |
| **New session** (`new`) | opens a new Terminal window running `claude` in any project, or a headless background run whose card appears in the grid |
| **Follow-up** (`follow` in details) | sends a prompt to a *fork* of an existing session (runs in background with its full history) |
| **Jump** (`jump`) | brings the Terminal tab running that session to the front |
| **Interrupt** (`stop`) | stop a runaway session's current turn (like pressing Esc there) |
| **Knowledge graph** | auto-runs `graphify update`/`watch` (zero tokens for code) in projects that have `graphify-out/`; badges you when docs need the LLM path |
| **Timeline** | your recent prompts across ALL sessions (PgUp/PgDn to scroll) |

## Ask Claude about your own fleet

After `houston setup`, any Claude Code session can answer questions like *"what's going on across my terminals?"* — it calls the `houston` MCP tools:

`list_sessions` · `session_detail` · `summarize_session` · `stats` · `recent_activity` · `project_git_status`

## How it works

Houston never patches or wraps Claude Code. It reads the state Claude Code already writes:

- `~/.claude/sessions/<PID>.json` — live registry (deleted on exit → houston tombstones)
- `~/.claude/projects/**/<sessionId>.jsonl` — transcripts (streamed with byte caps; lines can be MBs)
- `~/.claude/history.jsonl` — global prompt history

Headless AI helpers run `claude -p --model haiku --safe-mode` with strict budget caps (`--max-budget-usd`), so summaries cost ~$0.01–0.05 and never load your project config or fire your hooks.

Houston's own files live in `~/.claude/houston/` (summary cache, background-run logs, temp files).

## Notes

- macOS only (AppleScript for launching/jumping/notifications). Terminal.app is the supported terminal for `j`ump.
- First "new session" launch triggers a one-time macOS consent to control Terminal — click OK.
- Claude Code's session files are undocumented internals; houston parses defensively and degrades gracefully if a future version changes them.

## Dev

```bash
npm run dev        # run TUI from source (tsx)
npm test           # vitest suite
npm run build      # tsc → dist/
```
