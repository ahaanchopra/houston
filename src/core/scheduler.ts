import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';
import { typeIntoTerminal, openTerminalResume, startHeadlessRun } from './launcher.js';
import type { ScheduleEntry } from './types.js';

const schedulesFile = path.join(houstonDir, 'schedules.json');
// A schedule that Houston only saw hours late (laptop asleep, TUI closed) is stale —
// firing "continue" at 8pm for a 7:30am reset is rarely what the user meant.
const MISSED_AFTER_MS = 12 * 3600_000;

export function listSchedules(): ScheduleEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveSchedules(entries: ScheduleEntry[]): void {
  fs.mkdirSync(houstonDir, { recursive: true });
  const tmp = `${schedulesFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, schedulesFile);
}

export function addSchedule(input: {
  sessionId: string;
  agent?: 'claude' | 'codex';
  cwd: string;
  at: number;
  prompt: string;
  label?: string;
}): ScheduleEntry {
  const entry: ScheduleEntry = {
    id: `sch-${Date.now()}`,
    sessionId: input.sessionId,
    agent: input.agent,
    cwd: input.cwd,
    at: input.at,
    prompt: input.prompt,
    label: input.label,
    createdAt: Date.now(),
    status: 'pending',
  };
  // one pending schedule per session — a new one replaces the old
  const rest = listSchedules().filter((s) => !(s.sessionId === input.sessionId && s.status === 'pending'));
  saveSchedules([...rest, entry]);
  return entry;
}

export function cancelSchedule(sessionId: string): boolean {
  const all = listSchedules();
  const next = all.filter((s) => !(s.sessionId === sessionId && s.status === 'pending'));
  if (next.length === all.length) return false;
  saveSchedules(next);
  return true;
}

export function pendingSchedules(): ScheduleEntry[] {
  return listSchedules().filter((s) => s.status === 'pending');
}

// "1900", "730", "7", "7:30", "7:30am", "7pm" → next occurrence of that local
// wall-clock time. The colon is optional: 3-4 bare digits are read as HHMM.
export function parseTimeSpec(spec: string, now = Date.now()): number | undefined {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/i.exec(spec.trim());
  if (!m) return undefined;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (hours > 23 || minutes > 59) return undefined;
  if (meridiem && hours > 12) return undefined;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export interface FireResult {
  entry: ScheduleEntry;
  ok: boolean;
  how: string;
}

// Continuation ladder, most faithful first:
//   1. type the prompt into the session's still-open Terminal tab (resumes in place)
//   2. open a fresh Terminal window with `claude --resume <sessionId>`
//   3. headless background follow-up (forked resume) as the last resort
export async function fireDueSchedules(
  resolvePid: (sessionId: string) => number | undefined,
  now = Date.now(),
): Promise<FireResult[]> {
  const all = listSchedules();
  const results: FireResult[] = [];
  let dirty = false;
  for (const entry of all) {
    if (entry.status !== 'pending' || entry.at > now) continue;
    dirty = true;
    if (now - entry.at > MISSED_AFTER_MS) {
      entry.status = 'missed';
      entry.note = 'houston was not running near the scheduled time';
      results.push({ entry, ok: false, how: 'missed — houston was not running near the scheduled time' });
      continue;
    }
    try {
      const pid = resolvePid(entry.sessionId);
      if (pid !== undefined && (await typeIntoTerminal(pid, entry.prompt))) {
        entry.status = 'fired';
        entry.note = 'typed into its Terminal tab';
      } else {
        try {
          await openTerminalResume(entry.cwd, entry.sessionId, entry.prompt, entry.agent);
          entry.status = 'fired';
          entry.note = 'opened a new Terminal window resuming the session';
        } catch (err) {
          if (entry.agent === 'codex') {
            // no headless fallback for codex — claude -p can't resume a codex thread
            entry.status = 'failed';
            entry.note = `could not reach the codex session: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
            results.push({ entry, ok: false, how: entry.note });
            continue;
          }
          startHeadlessRun(entry.cwd, entry.prompt, { resumeSessionId: entry.sessionId });
          entry.status = 'fired';
          entry.note = 'started a background follow-up run';
        }
      }
      entry.firedAt = now;
      results.push({ entry, ok: true, how: entry.note });
    } catch (err) {
      entry.status = 'failed';
      entry.note = String((err as Error)?.message ?? err).slice(0, 200);
      results.push({ entry, ok: false, how: `failed: ${entry.note}` });
    }
  }
  if (dirty) saveSchedules(all);
  return results;
}
