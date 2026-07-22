import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { sessionsDir, houstonDir } from './paths.js';
import { isWindows, winProcStartEpochMs } from './platform/win32.js';
import type { RegistryEntry } from './types.js';

// Live-session registry: ~/.claude/sessions/<PID>.json. The file is DELETED on graceful
// exit, so a lingering file with a dead PID means the session crashed.
export function readRegistry(): RegistryEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      if (raw && typeof raw.pid === 'number' && typeof raw.sessionId === 'string') {
        entries.push(raw);
      }
    } catch {
      // partial write or unknown format — a card can't render from garbage, skip
    }
  }
  return entries;
}

// Only ESRCH means the process is gone; EPERM means alive but owned by another user.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// PID-reuse guard: if ps reports a start time far from the registry's, the PID was
// recycled by another process. Times must be compared as epochs, not strings — the
// registry's procStart is written in UTC while ps lstart is local time.
const START_TOLERANCE_MS = 5 * 60_000;

function startTimesMatch(liveMs: number, entry: { procStart?: string; startedAt?: number }): boolean {
  if (typeof entry.startedAt === 'number') {
    return Math.abs(liveMs - entry.startedAt) < START_TOLERANCE_MS;
  }
  if (entry.procStart) {
    const asUtc = Date.parse(`${entry.procStart} UTC`);
    const asLocal = Date.parse(entry.procStart);
    return [asUtc, asLocal].some((t) => !Number.isNaN(t) && Math.abs(liveMs - t) < START_TOLERANCE_MS);
  }
  return true;
}

export async function procStartMatches(
  pid: number,
  entry: { procStart?: string; startedAt?: number },
): Promise<boolean> {
  if (isWindows) {
    // Get-Process StartTime (cached); undetermined → don't false-flag a live session
    const liveMs = await winProcStartEpochMs(pid);
    return liveMs === undefined ? true : startTimesMatch(liveMs, entry);
  }
  try {
    const { stdout } = await execa('ps', ['-p', String(pid), '-o', 'lstart=']);
    const live = stdout.trim();
    if (!live) return false;
    const liveMs = Date.parse(live); // ps lstart is local time
    if (Number.isNaN(liveMs)) return true; // unparseable — don't false-flag a live session
    return startTimesMatch(liveMs, entry);
  } catch {
    return false;
  }
}

// Houston's own headless children must not show up as user sessions.
export function isHoustonChild(entry: RegistryEntry): boolean {
  if (entry.kind && entry.kind !== 'interactive') return true;
  if (entry.cwd && entry.cwd.startsWith(houstonDir)) return true;
  return false;
}
