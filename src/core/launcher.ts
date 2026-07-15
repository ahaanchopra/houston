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

export async function openTerminalWindow(dir: string, prompt?: string): Promise<void> {
  const args = [dir];
  if (prompt?.trim()) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `prompt-${Date.now()}.txt`);
    fs.writeFileSync(file, prompt);
    args.push(file);
  }
  await execa('osascript', ['-e', OPEN_WINDOW_SCRIPT, ...args]);
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
    const { stdout: result } = await execa('osascript', ['-e', JUMP_SCRIPT, tty]);
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
