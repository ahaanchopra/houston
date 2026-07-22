import { execa } from 'execa';
import { writeTempFile } from '../paths.js';

// Windows implementations of everything macOS does with AppleScript. Same contracts,
// PowerShell underneath: Windows Terminal (wt.exe) when installed, plain PowerShell
// windows otherwise, WScript.Shell for window focus + keystrokes, WinRT for toasts.

export const isWindows = process.platform === 'win32';

// Single-quote a value for embedding in PowerShell source ('' escapes ').
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// SendKeys treats +^%~(){}[] as control syntax — brace-escape them so prompt text
// arrives literally.
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

async function runPs(script: string, timeout = 20_000): Promise<string> {
  const { stdout } = await execa(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, windowsHide: true },
  );
  return stdout.trim();
}

// Launch a .ps1 in a fresh visible window: Windows Terminal if present, else a plain
// PowerShell window via `start` (works from both cmd and PowerShell setups).
async function launchWindow(ps1: string): Promise<void> {
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ps1];
  try {
    await execa('wt.exe', ['powershell.exe', ...psArgs], { timeout: 15_000 });
  } catch {
    await execa('cmd.exe', ['/d', '/s', '/c', 'start', '', 'powershell.exe', ...psArgs], {
      timeout: 15_000,
      windowsHide: true,
    });
  }
}

export async function winOpenTerminalWindow(dir: string, prompt?: string): Promise<void> {
  const lines = [`Set-Location -LiteralPath ${psQuote(dir)}`];
  if (prompt?.trim()) {
    const promptFile = writeTempFile('prompt', prompt);
    lines.push(`claude "$(Get-Content -Raw -LiteralPath ${psQuote(promptFile)})"`);
  } else {
    lines.push('claude');
  }
  await launchWindow(writeTempFile('launch', lines.join('\r\n'), '.ps1'));
}

export async function winOpenTerminalResume(dir: string, sessionId: string, prompt: string): Promise<void> {
  const promptFile = writeTempFile('prompt', prompt);
  const script = [
    `Set-Location -LiteralPath ${psQuote(dir)}`,
    `claude --resume ${psQuote(sessionId)} "$(Get-Content -Raw -LiteralPath ${psQuote(promptFile)})"`,
  ].join('\r\n');
  await launchWindow(writeTempFile('resume', script, '.ps1'));
}

// AppActivate(pid) focuses the window OWNED by that process: classic conhost windows
// match; under Windows Terminal the window belongs to WindowsTerminal.exe, so this
// returns false and callers fall back (scheduler ladder → new-window resume).
export async function winTypeIntoTerminal(pid: number, text: string): Promise<boolean> {
  const keysFile = writeTempFile('keys', escapeSendKeys(text.replace(/\s*\n\s*/g, ' ')));
  const script = `
$sh = New-Object -ComObject WScript.Shell
if (-not $sh.AppActivate(${Math.floor(pid)})) { Write-Output 'notfound'; exit 0 }
Start-Sleep -Milliseconds 400
$keys = (Get-Content -Raw -LiteralPath ${psQuote(keysFile)}).TrimEnd()
$sh.SendKeys($keys)
Start-Sleep -Milliseconds 200
$sh.SendKeys('{ENTER}')
Write-Output 'ok'`;
  try {
    return (await runPs(script)) === 'ok';
  } catch {
    return false;
  }
}

export async function winJumpToTerminal(pid: number): Promise<boolean> {
  try {
    const out = await runPs(
      `$sh = New-Object -ComObject WScript.Shell; if ($sh.AppActivate(${Math.floor(pid)})) { 'ok' } else { 'notfound' }`,
      10_000,
    );
    return out === 'ok';
  } catch {
    return false;
  }
}

// SIGINT on Windows would TERMINATE the session outright, so "interrupt" is done the
// way a human would: focus the window and press Esc. Fire-and-forget best effort.
export function winInterruptSession(pid: number): boolean {
  const script = `
$sh = New-Object -ComObject WScript.Shell
if ($sh.AppActivate(${Math.floor(pid)})) { Start-Sleep -Milliseconds 300; $sh.SendKeys('{ESC}') }`;
  void runPs(script, 10_000).catch(() => {});
  return true;
}

export async function winNotify(title: string, body: string): Promise<void> {
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode(${psQuote(title)})) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode(${psQuote(body)})) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Houston').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  await runPs(script, 10_000);
}

// A process start time never changes while the PID is alive, and callers gate on
// isAlive() first — a short cache keeps the 5s liveness poll from spawning a
// PowerShell per session per tick.
const startCache = new Map<number, { at: number; epochMs?: number }>();
const START_CACHE_MS = 30_000;

export async function winProcStartEpochMs(pid: number): Promise<number | undefined> {
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < START_CACHE_MS) return hit.epochMs;
  let epochMs: number | undefined;
  try {
    const out = await runPs(`(Get-Process -Id ${Math.floor(pid)}).StartTime.ToUniversalTime().ToString('o')`, 10_000);
    const parsed = Date.parse(out);
    epochMs = Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    epochMs = undefined;
  }
  startCache.set(pid, { at: Date.now(), epochMs });
  return epochMs;
}

// Node's spawn() can't exec the `claude.cmd` npm shim directly (EINVAL since the
// CVE-2024-27980 hardening) — route through cmd.exe. Args are still passed as argv,
// never string-interpolated.
export function claudeSpawnCommand(args: string[]): { cmd: string; args: string[] } {
  return isWindows
    ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...args] }
    : { cmd: 'claude', args };
}
