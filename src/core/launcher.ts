import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { runsDir, tmpDir } from './paths.js';

// Prompts go through a temp file + AppleScript argv — never interpolated into script
// source or shell strings, so quotes/backslashes in prompts can't break or inject.
const OPEN_WINDOW_SCRIPT = `
on run argv
  set d to item 1 of argv
  tell application "Terminal"
    activate
    if (count of argv) > 1 then
      do script "cd " & quoted form of d & " && claude \\"$(cat " & quoted form of (item 2 of argv) & ")\\""
    else
      do script "cd " & quoted form of d & " && claude"
    end if
  end tell
end run
`;

const JUMP_SCRIPT = `
on run argv
  set wantedTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) ends with wantedTty then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run
`;

// Type text into the Terminal tab running a given session (found by tty) and press
// return — resumes a limit-paused REPL exactly where it stopped. Needs the Accessibility
// permission (System Events keystroke); macOS prompts on first use.
const TYPE_SCRIPT = `
on run argv
  set wantedTty to item 1 of argv
  set msg to read POSIX file (item 2 of argv) as «class utf8»
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) ends with wantedTty then
          set selected of t to true
          set index of w to 1
          activate
          delay 0.4
          tell application "System Events"
            keystroke msg
            delay 0.2
            key code 36
          end tell
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run
`;

const RESUME_WINDOW_SCRIPT = `
on run argv
  set d to item 1 of argv
  set sid to item 2 of argv
  tell application "Terminal"
    activate
    do script "cd " & quoted form of d & " && claude --resume " & quoted form of sid & " \\"$(cat " & quoted form of (item 3 of argv) & ")\\""
  end tell
end run
`;

function writePromptFile(prompt: string): string {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `prompt-${Date.now()}.txt`);
  fs.writeFileSync(file, prompt);
  return file;
}

export async function typeIntoTerminal(pid: number, text: string): Promise<boolean> {
  try {
    const { stdout } = await execa('ps', ['-o', 'tty=', '-p', String(pid)]);
    const tty = stdout.trim();
    if (!tty || tty === '??') return false;
    // keystroke can't type newlines reliably — collapse the prompt onto one line
    const file = writePromptFile(text.replace(/\s*\n\s*/g, ' '));
    const { stdout: result } = await execa('osascript', ['-e', TYPE_SCRIPT, tty, file], { timeout: 20_000 });
    return result.trim() === 'ok';
  } catch {
    return false;
  }
}

export async function openTerminalResume(dir: string, sessionId: string, prompt: string): Promise<void> {
  const file = writePromptFile(prompt);
  await execa('osascript', ['-e', RESUME_WINDOW_SCRIPT, dir, sessionId, file], { timeout: 15_000 });
}

export async function openTerminalWindow(dir: string, prompt?: string): Promise<void> {
  const args = [dir];
  if (prompt?.trim()) args.push(writePromptFile(prompt));
  await execa('osascript', ['-e', OPEN_WINDOW_SCRIPT, ...args], { timeout: 15_000 });
}

export interface RunInfo {
  id: string;
  pid?: number;
  dir: string;
  prompt: string;
  startedAt: number;
  logFile: string;
  kind: 'headless' | 'follow-up';
  resumeSessionId?: string;
}

// Headless runs must survive the TUI exiting: stdout goes straight to a file descriptor
// (a Node pipe would stall on backpressure once the parent dies) and the child is unref'd.
export function startHeadlessRun(dir: string, prompt: string, opts: { resumeSessionId?: string } = {}): RunInfo {
  fs.mkdirSync(runsDir, { recursive: true });
  const id = `run-${Date.now()}`;
  const logFile = path.join(runsDir, `${id}.jsonl`);
  const fd = fs.openSync(logFile, 'a');
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--max-budget-usd', '2.00',
  ];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId, '--fork-session');
  const child = spawn('claude', args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, HOUSTON_CHILD: '1' },
  });
  // async spawn failures (claude missing from PATH etc.) emit 'error' — unhandled, it
  // would crash the whole TUI
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logFile, JSON.stringify({ type: 'houston-spawn-error', error: String(err) }) + '\n');
    } catch {
      // log file gone — nothing left to report to
    }
  });
  child.unref();
  fs.closeSync(fd);
  const info: RunInfo = {
    id,
    pid: child.pid,
    dir,
    prompt: prompt.slice(0, 500),
    startedAt: Date.now(),
    logFile,
    kind: opts.resumeSessionId ? 'follow-up' : 'headless',
    resumeSessionId: opts.resumeSessionId,
  };
  fs.writeFileSync(path.join(runsDir, `${id}.meta.json`), JSON.stringify(info, null, 2));
  return info;
}

export function listRuns(): RunInfo[] {
  try {
    return fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')) as RunInfo;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is RunInfo => Boolean(r))
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

// Works for Terminal.app tabs; iTerm/VS Code/detached ("??") sessions return false.
export async function jumpToTerminal(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execa('ps', ['-o', 'tty=', '-p', String(pid)]);
    const tty = stdout.trim();
    if (!tty || tty === '??') return false;
    const { stdout: result } = await execa('osascript', ['-e', JUMP_SCRIPT, tty], { timeout: 10_000 });
    return result.trim() === 'ok';
  } catch {
    return false;
  }
}

// SIGINT = same as pressing Esc/Ctrl-C in that session: cancels the current turn.
export function interruptSession(pid: number): boolean {
  try {
    process.kill(pid, 'SIGINT');
    return true;
  } catch {
    return false;
  }
}
