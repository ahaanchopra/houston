import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { readHeadRecords, readTailRecords, type JsonlRecord } from './transcriptReader.js';
import { parseResetTime } from './limits.js';
import { contextPct } from './contextMeter.js';
import { isWindows } from './platform/win32.js';
import type { Session, SessionIntel, LimitInfo } from './types.js';
import type { TurnView } from './transcriptIndex.js';

// Codex CLI session support (verified against codex-cli 0.144.6 on this machine):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl   — JSONL transcripts
//   ~/.codex/session_index.jsonl                             — {id, thread_name, updated_at}
// There is NO live-PID registry like Claude's ~/.claude/sessions/<PID>.json, so
// liveness = lsof pairing (codex keeps its rollout open for appending) with an
// mtime-freshness fallback where lsof is unavailable (Windows).

export const codexDir = path.join(os.homedir(), '.codex');
const codexSessionsDir = path.join(codexDir, 'sessions');
const codexIndexFile = path.join(codexDir, 'session_index.jsonl');

const SHOW_WINDOW_MS = 24 * 3600_000; // same as Claude's ended-card window
const FRESH_MS = 3 * 60_000; // no pid pairing → "written recently" counts as alive

function payload(rec: JsonlRecord): any {
  return (rec as any).payload ?? {};
}

function eventType(rec: JsonlRecord): string | undefined {
  return rec.type === 'event_msg' ? payload(rec).type : undefined;
}

// Busy = a turn started and neither completed nor aborted since.
export function codexIsBusy(tail: JsonlRecord[]): boolean {
  let busy = false;
  for (const rec of tail) {
    const t = eventType(rec);
    if (t === 'task_started') busy = true;
    else if (t === 'task_complete' || t === 'turn_aborted') busy = false;
  }
  return busy;
}

// A trailing error event about usage limits ⇒ the session is paused on a limit.
// (Shape unverified — codex errors are rare in local rollouts; matched loosely.)
export function codexFindLimit(tail: JsonlRecord[]): LimitInfo | undefined {
  let limit: LimitInfo | undefined;
  for (const rec of tail) {
    const t = eventType(rec);
    const p = payload(rec);
    if (t === 'error' && typeof p.message === 'string' && /usage limit|rate limit/i.test(p.message)) {
      const hitAt = Date.parse((rec as any).timestamp ?? '') || Date.now();
      limit = { message: p.message, hitAt, resetsAt: parseResetTime(p.message, hitAt) };
    } else if (t === 'user_message' || t === 'agent_message' || t === 'task_complete') {
      limit = undefined;
    }
  }
  return limit;
}

export function buildCodexIntel(tail: JsonlRecord[], title?: string): SessionIntel & { window?: number } {
  const intel: SessionIntel & { window?: number } = { turns: 0, filesTouched: [], contextTokens: 0, title };
  for (const rec of tail) {
    const t = eventType(rec);
    const p = payload(rec);
    if (t === 'user_message' && typeof p.message === 'string') {
      intel.turns += 1;
      intel.lastPrompt = p.message;
      if (!intel.firstPrompt) intel.firstPrompt = p.message;
    } else if (t === 'token_count' && p.info) {
      const usage = p.info.last_token_usage ?? p.info.total_token_usage;
      // input_tokens already includes cached_input_tokens (a subset, not additive)
      if (usage) intel.contextTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      if (typeof p.info.model_context_window === 'number') intel.window = p.info.model_context_window;
    } else if (t === 'task_started' && typeof p.model_context_window === 'number') {
      intel.window = p.model_context_window;
    } else if (t === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') {
      intel.model = p.thread_settings.model;
    }
  }
  intel.limit = codexFindLimit(tail);
  return intel;
}

// Codex flavor of transcriptIndex.buildRecentTurns for the conversation peek.
export function buildCodexTurns(tail: JsonlRecord[], count = 10, maxChars = 400): TurnView[] {
  const turns: TurnView[] = [];
  for (const rec of tail) {
    const t = eventType(rec);
    const p = payload(rec);
    if (t === 'user_message' && typeof p.message === 'string') {
      turns.push({ role: 'user', text: String(p.message).slice(0, 1000), tools: [] });
    } else if (t === 'agent_message' && typeof p.message === 'string') {
      const prev = turns[turns.length - 1];
      if (prev && prev.role === 'assistant') prev.text = `${prev.text} ${p.message}`.trim().slice(0, maxChars);
      else turns.push({ role: 'assistant', text: String(p.message).slice(0, maxChars), tools: [] });
    } else if (rec.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const prev = turns[turns.length - 1];
      const name = String(p.name ?? 'tool');
      if (prev && prev.role === 'assistant') prev.tools.push(name);
      else turns.push({ role: 'assistant', text: '', tools: [name] });
    }
  }
  return turns.slice(-count);
}

// thread names from ~/.codex/session_index.jsonl — later lines win
function readSessionTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(codexIndexFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.id === 'string' && typeof entry?.thread_name === 'string') {
          titles.set(entry.id, entry.thread_name);
        }
      } catch {
        // partial line
      }
    }
  } catch {
    // no index — titles fall back to the first prompt
  }
  return titles;
}

// codex keeps its rollout file open for appending — lsof pairs pid → rollout path.
// Windows/lsof-missing: empty map, liveness falls back to mtime freshness.
async function codexPidsByRollout(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (isWindows) return map;
  try {
    const { stdout } = await execa('lsof', ['-c', 'codex', '-Fpn'], { timeout: 10_000, reject: false });
    let pid: number | undefined;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== undefined && line.includes(`${path.sep}sessions${path.sep}`) && line.includes('rollout-')) {
        map.set(line.slice(1), pid);
      }
    }
  } catch {
    // lsof unavailable — mtime fallback carries liveness
  }
  return map;
}

// Only date-dirs inside the visibility window get walked — the archive can span years.
function recentRolloutFiles(now: number): Array<{ file: string; mtimeMs: number }> {
  const out: Array<{ file: string; mtimeMs: number }> = [];
  for (let dayOffset = 0; dayOffset <= Math.ceil(SHOW_WINDOW_MS / 86_400_000); dayOffset++) {
    const d = new Date(now - dayOffset * 86_400_000);
    const dir = path.join(
      codexSessionsDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    } catch {
      continue; // no sessions that day
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        if (now - mtimeMs <= SHOW_WINDOW_MS) out.push({ file, mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out;
}

const intelCache = new Map<string, { key: string; session: Session }>();

export async function buildCodexSessions(): Promise<Session[]> {
  const now = Date.now();
  const rollouts = recentRolloutFiles(now);
  if (rollouts.length === 0) return [];
  const [pids, titles] = [await codexPidsByRollout(), readSessionTitles()];
  const sessions: Session[] = [];
  for (const { file, mtimeMs } of rollouts) {
    const pid = pids.get(file);
    const cacheKey = `${mtimeMs}:${pid ?? ''}`;
    const hit = intelCache.get(file);
    if (hit && hit.key === cacheKey) {
      sessions.push(hit.session);
      continue;
    }
    try {
      const head = await readHeadRecords(file);
      const meta = head.find((r) => r.type === 'session_meta');
      if (!meta) continue;
      const mp = payload(meta);
      if (mp.thread_source === 'subagent') continue; // spawned threads are not user sessions
      const id = String(mp.id ?? mp.session_id ?? '');
      if (!id) continue;
      const tail = await readTailRecords(file);
      const intel = buildCodexIntel(tail, titles.get(id));
      const alive = pid !== undefined || now - mtimeMs < FRESH_MS;
      let status: Session['status'] = alive ? (codexIsBusy(tail) ? 'busy' : 'idle') : 'ended';
      if (alive && intel.limit) {
        status = intel.limit.resetsAt !== undefined && intel.limit.resetsAt <= now ? 'idle' : 'limited';
      }
      const session: Session = {
        sessionId: id,
        pid,
        agent: 'codex',
        name: 'codex',
        cwd: typeof mp.cwd === 'string' ? mp.cwd : '',
        status,
        startedAt: Date.parse(mp.timestamp ?? '') || undefined,
        lastActivityAt: mtimeMs,
        transcriptPath: file,
        transcriptMtimeMs: mtimeMs,
        intel,
        contextWindow: intel.window,
        contextPct: intel.window ? contextPct(intel.contextTokens, intel.window) : undefined,
      };
      if (!alive) session.endReason = 'exited';
      intelCache.set(file, { key: cacheKey, session });
      sessions.push(session);
    } catch {
      // unreadable rollout — skip rather than crash the refresh
    }
  }
  return sessions;
}
