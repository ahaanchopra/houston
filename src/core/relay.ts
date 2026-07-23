import os from 'node:os';
import type { SessionStore } from './store.js';
import { readConfig } from './config.js';
import { addSchedule, cancelSchedule, parseTimeSpec } from './scheduler.js';
import { addQueued, clearQueued } from './queue.js';
import { setPauseRule, clearPauseRule } from './pauses.js';
import { dismissSession } from './dismissals.js';
import { writeConfig } from './config.js';
import { typeIntoTerminal, openTerminalResume, interruptSession } from './launcher.js';
import type { Session } from './types.js';

// Phone-app relay: the daemon POSTs a trimmed fleet snapshot to the EC2 relay every
// few seconds and executes whatever commands the phone queued there. Outbound-only —
// no port is ever opened on this machine; NAT and firewalls are non-issues.

const REPORT_INTERVAL_MS = 5000;
const PROMPT_MAX = 2000;

interface RelayCommand {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

interface CommandResult {
  id: string;
  ok: boolean;
  note: string;
}

function trimSessions(sessions: Session[]) {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    title: s.intel?.title ?? s.name ?? s.sessionId.slice(0, 8),
    agent: s.agent ?? 'claude',
    status: s.status,
    cwd: s.cwd,
    model: s.intel?.model,
    contextPct: s.contextPct,
    contextTokens: s.intel?.contextTokens,
    contextWindow: s.contextWindow,
    turns: s.intel?.turns,
    lastPrompt: s.intel?.lastPrompt?.slice(0, 200),
    lastActivityAt: s.lastActivityAt,
    startedAt: s.startedAt,
    maybeWaiting: s.maybeWaiting ?? false,
    danger: s.danger ?? false,
    limitResetsAt: s.intel?.limit?.resetsAt,
    endReason: s.endReason,
  }));
}

async function execute(store: SessionStore, cmd: RelayCommand): Promise<CommandResult> {
  const p = cmd.payload ?? {};
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
  const session = sessionId ? store.findSession(sessionId) : undefined;
  const need = (): Session => {
    if (!session) throw new Error('session not found on this machine');
    return session;
  };
  const prompt = typeof p.prompt === 'string' ? p.prompt.slice(0, PROMPT_MAX) : '';
  try {
    switch (cmd.type) {
      case 'continue':
      case 'prompt': {
        const s = need();
        const text = cmd.type === 'continue' ? 'continue' : prompt;
        if (!text) throw new Error('empty prompt');
        if (s.pid !== undefined && (await typeIntoTerminal(s.pid, text))) {
          return { id: cmd.id, ok: true, note: 'typed into its terminal' };
        }
        await openTerminalResume(s.cwd, s.sessionId, text, s.agent);
        return { id: cmd.id, ok: true, note: 'opened a new window resuming it' };
      }
      case 'stop': {
        const s = need();
        if (s.pid === undefined) throw new Error('no pid');
        return { id: cmd.id, ok: interruptSession(s.pid), note: 'interrupt sent (like pressing Esc)' };
      }
      case 'schedule': {
        const s = need();
        const at =
          typeof p.at === 'number' ? p.at : typeof p.timeSpec === 'string' ? parseTimeSpec(p.timeSpec) : undefined;
        if (at === undefined || at <= Date.now()) throw new Error('bad or past time');
        addSchedule({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd, at, prompt: prompt || 'continue', label: s.intel?.title ?? s.name });
        return { id: cmd.id, ok: true, note: `scheduled ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` };
      }
      case 'unschedule':
        return { id: cmd.id, ok: cancelSchedule(need().sessionId), note: 'schedule cleared' };
      case 'queue': {
        if (!prompt) throw new Error('empty prompt');
        addQueued({ sessionId: need().sessionId, agent: session!.agent, prompt });
        return { id: cmd.id, ok: true, note: 'queued — sends when idle' };
      }
      case 'unqueue':
        return { id: cmd.id, ok: clearQueued(need().sessionId) > 0, note: 'queue cleared' };
      case 'complete':
        dismissSession(need().sessionId);
        store.scheduleRefresh();
        return { id: cmd.id, ok: true, note: 'completed' };
      case 'pause': {
        const pct = Number(p.pct);
        if (!Number.isFinite(pct) || pct < 1 || pct > 100) throw new Error('bad pct');
        setPauseRule(need().sessionId, pct);
        return { id: cmd.id, ok: true, note: `winds down at ~${pct}%` };
      }
      case 'unpause':
        return { id: cmd.id, ok: clearPauseRule(need().sessionId), note: 'pause rule cleared' };
      case 'autocontinue': {
        const on = Boolean(p.on);
        writeConfig({ autoContinue: on });
        return { id: cmd.id, ok: true, note: on ? 'auto-continue on' : 'auto-continue off' };
      }
      case 'graphify': {
        const s = need();
        if (s.pid === undefined) throw new Error('no pid');
        const ok = await typeIntoTerminal(s.pid, 'update graphify');
        return { id: cmd.id, ok, note: ok ? 'asked it to update its graph' : 'window unreachable' };
      }
      default:
        throw new Error(`unknown command "${cmd.type}"`);
    }
  } catch (err) {
    return { id: cmd.id, ok: false, note: String((err as Error)?.message ?? err).slice(0, 160) };
  }
}

// Started by the daemon only — the TUI never talks to the relay.
export function startRelay(store: SessionStore): void {
  const relay = readConfig().relay;
  if (!relay?.url || !relay?.token) {
    console.log('[houston] relay not configured (config.json → relay.url/token) — phone app disabled.');
    return;
  }
  const host = relay.host ?? os.hostname();
  const endpoint = `${relay.url.replace(/\/$/, '')}/mission/api/report`;
  let pendingResults: CommandResult[] = [];
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const snap = store.snapshot;
      const body = {
        host,
        platform: process.platform,
        snapshot: snap
          ? {
              sessions: trimSessions(snap.sessions),
              usage: snap.usage,
              schedules: snap.schedules,
              queue: snap.queue.map((q) => ({ sessionId: q.sessionId, prompt: q.prompt.slice(0, 120) })),
              pauses: snap.pauses,
              alerts: snap.alerts,
              autoContinue: Boolean(readConfig().autoContinue),
              generatedAt: snap.generatedAt,
            }
          : undefined,
        results: pendingResults.splice(0),
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const data: any = await res.json().catch(() => ({}));
      for (const cmd of Array.isArray(data.commands) ? data.commands : []) {
        const result = await execute(store, cmd);
        pendingResults.push(result);
        store.scheduleRefresh();
      }
    } catch {
      // box unreachable — next tick retries; the daemon's local duties are unaffected
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), REPORT_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(`[houston] relay on — reporting to ${relay.url} as "${host}".`);
}
