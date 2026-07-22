import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { sessionsDir, historyFile, ensureDirs } from './paths.js';
import { buildLiveSessions, buildProjects, sortSessions } from './snapshot.js';
import { readDismissals, isDismissed } from './dismissals.js';
import { readTimeline } from './historyReader.js';
import { AlertTracker } from './alerts.js';
import { GraphifyBridge } from './graphifyBridge.js';
import { pendingSchedules, fireDueSchedules, addSchedule } from './scheduler.js';
import { listQueue, nextQueuedFor, removeQueued } from './queue.js';
import { UsageTracker } from './usage.js';
import { readConfig } from './config.js';
import { appendEvent } from './digest.js';
import { daemonAlive } from './daemonLock.js';
import { listPauseRules, dueRules, removeRule } from './pauses.js';
import { typeIntoTerminal, interruptSession } from './launcher.js';
import { notify } from './notifier.js';
import type { Session, Snapshot, UsageSummary } from './types.js';

const DEBOUNCE_MS = 100;
const LIVENESS_POLL_MS = 5000;
const SCHEDULE_POLL_MS = 30_000;
const HIDE_ENDED_AFTER_MS = 24 * 3600_000;

// Single source of truth for the TUI: watches Claude Code's on-disk state and emits
// debounced `snapshot` events. Tombstones live here because "ended gracefully" is only
// observable as a registry-file unlink — the disk forgets, we remember.
export class SessionStore extends EventEmitter {
  readonly graphify = new GraphifyBridge();
  readonly usage = new UsageTracker();
  snapshot?: Snapshot;

  private readonly actor: 'tui' | 'daemon';
  private prevSessions = new Map<string, Session>();
  private tombstones = new Map<string, Session>();
  private alertTracker: AlertTracker;
  private warned80 = false;
  private queueFailNotified = new Set<string>();
  private watchers: FSWatcher[] = [];
  private transcriptWatcher?: FSWatcher;
  private watchedTranscripts = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private scheduleTimer?: NodeJS.Timeout;
  private refreshing = false;
  private pendingRefresh = false;

  constructor(opts: { actor?: 'tui' | 'daemon' } = {}) {
    super();
    this.actor = opts.actor ?? 'tui';
    // single-firer rule: when a daemon holds the lock, the TUI renders alerts but
    // suppresses the macOS/Windows notification side effect (the daemon sends it)
    this.alertTracker = new AlertTracker((title, body, key) =>
      this.isAuthority() ? notify(title, body, key) : Promise.resolve(),
    );
  }

  // The process allowed to SEND things: fire schedules, type queued prompts, notify.
  // The daemon always is; the TUI only when no live daemon holds the lock.
  isAuthority(): boolean {
    return this.actor === 'daemon' || !daemonAlive();
  }

  start(): void {
    ensureDirs();
    const sessionsWatcher = chokidar.watch(sessionsDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    sessionsWatcher.on('all', () => this.scheduleRefresh());
    const historyWatcher = chokidar.watch(historyFile, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    historyWatcher.on('all', () => this.scheduleRefresh());
    this.transcriptWatcher = chokidar.watch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.transcriptWatcher.on('change', () => this.scheduleRefresh());
    // an unhandled 'error' on any watcher's EventEmitter would throw and kill the TUI;
    // the 5s liveness poll keeps refreshes flowing even if a watcher degrades
    for (const watcher of [sessionsWatcher, historyWatcher, this.transcriptWatcher]) {
      watcher.on('error', () => {});
    }
    this.watchers.push(sessionsWatcher, historyWatcher, this.transcriptWatcher);
    this.pollTimer = setInterval(() => this.scheduleRefresh(), LIVENESS_POLL_MS);
    this.pollTimer.unref?.();
    this.scheduleTimer = setInterval(() => void this.fireSchedules(), SCHEDULE_POLL_MS);
    this.scheduleTimer.unref?.();
    // catch-up for schedules that came due while houston was closed — delayed a few
    // seconds so the first refresh has populated prevSessions (pid lookup for the
    // type-into-tab path) before anything fires
    setTimeout(() => void this.fireSchedules(), 5000).unref?.();
    this.scheduleRefresh();
  }

  // Fires due auto-continue schedules. Emits 'schedule-fired' per attempt so the TUI
  // can toast the outcome.
  private async fireSchedules(): Promise<void> {
    if (!this.isAuthority()) return;
    if (pendingSchedules().length === 0) return;
    const results = await fireDueSchedules(
      (sessionId) => this.prevSessions.get(sessionId)?.pid,
    );
    for (const result of results) {
      this.emit('schedule-fired', result);
      if (result.ok) appendEvent({ at: Date.now(), kind: 'schedule-fired', title: result.entry.label, detail: result.how });
    }
    if (results.length > 0) this.scheduleRefresh();
  }

  stop(): void {
    for (const watcher of this.watchers) void watcher.close();
    this.watchers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.graphify.stopAll();
  }

  dismissAlert(sessionId: string): void {
    this.alertTracker.dismiss(sessionId);
    this.scheduleRefresh();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      const prev = this.prevSessions;
      const live = await buildLiveSessions();
      const next = new Map<string, Session>(live.map((s) => [s.sessionId, s]));

      // Sessions that vanished from the registry exited gracefully — tombstone them.
      for (const [id, session] of prev) {
        if (next.has(id) || this.tombstones.has(id)) continue;
        if (session.status !== 'ended' && !session.isHoustonChild) {
          this.tombstones.set(id, {
            ...session,
            status: 'ended',
            endedAt: Date.now(),
            endReason: 'exited',
            maybeWaiting: false,
          });
        }
      }
      for (const [id, tombstone] of this.tombstones) {
        if (next.has(id)) {
          this.tombstones.delete(id); // session resumed
          continue;
        }
        if (tombstone.endedAt && Date.now() - tombstone.endedAt > HIDE_ENDED_AFTER_MS) continue;
        next.set(id, tombstone);
      }

      const sessions = sortSessions([...next.values()]);
      const alerts = this.alertTracker.update(prev, sessions);
      const usage = await this.usage.refresh();
      await this.handleTransitions(prev, sessions, usage);
      // completed (dismissed) sessions are hidden from the dashboard but stay tracked
      // (prevSessions, transcript watchers) so they pop back on new activity — filtering
      // must NOT happen in buildLiveSessions or the diff above would tombstone them
      const dismissals = readDismissals();
      const visible = sessions.filter((s) => !isDismissed(s, dismissals));
      const [timeline, projects] = await Promise.all([readTimeline(50), buildProjects(visible)]);

      this.syncTranscriptWatchers(sessions);
      for (const project of projects) {
        if (project.hasGraphify) void this.graphify.start(project.root);
      }

      this.prevSessions = new Map(sessions.map((s) => [s.sessionId, s]));
      this.snapshot = {
        sessions: visible,
        timeline,
        projects,
        alerts,
        schedules: pendingSchedules(),
        queue: listQueue(),
        pauses: listPauseRules(),
        usage,
        generatedAt: Date.now(),
      };
      this.emit('snapshot', this.snapshot);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.refreshing = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.scheduleRefresh();
      }
    }
  }

  // Status-transition side effects: events log, limit calibration, auto-continue,
  // queued-prompt sends, 80% usage warning. Only the authority process SENDS anything.
  private async handleTransitions(prev: Map<string, Session>, sessions: Session[], usage: UsageSummary): Promise<void> {
    const now = Date.now();
    const authority = this.isAuthority();
    for (const session of sessions) {
      const before = prev.get(session.sessionId);
      const label = session.intel?.title ?? session.name ?? session.sessionId.slice(0, 8);

      if (before && before.status !== 'ended' && session.status === 'ended') {
        appendEvent({ at: now, kind: 'ended', title: label });
      }

      // real transition only — a restart seeing an already-limited session must not
      // re-log the event or push an undercounted calibration sample
      if (session.status === 'limited' && before && before.status !== 'limited') {
        appendEvent({ at: now, kind: 'limit-hit', title: label, detail: session.intel?.limit?.message?.slice(0, 120) });
        // the window total at the moment a limit hits IS (approximately) the cap
        this.usage.calibrate(now);
      }
      // auto-continue runs whenever a session sits limited (also catches daemon boot
      // finding one already paused); resetsAt>now + the pending check make it idempotent
      if (session.status === 'limited') {
        const resetsAt = session.intel?.limit?.resetsAt;
        if (
          authority &&
          readConfig().autoContinue &&
          resetsAt !== undefined &&
          resetsAt > now &&
          !pendingSchedules().some((s) => s.sessionId === session.sessionId)
        ) {
          const at = resetsAt + 2 * 60_000;
          addSchedule({ sessionId: session.sessionId, agent: session.agent, cwd: session.cwd, at, prompt: 'continue', label });
          void notify(
            'Houston',
            `"${label}" hit its limit — auto-scheduled continue at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`,
            `autocontinue-${session.sessionId}-${resetsAt}`,
          );
        }
      }

      // busy→idle: the session finished a turn — feed it the next queued prompt
      if (authority && before?.status === 'busy' && session.status === 'idle') {
        const entry = nextQueuedFor(session.sessionId);
        if (entry && session.pid !== undefined) {
          const ok = await typeIntoTerminal(session.pid, entry.prompt);
          if (ok) {
            removeQueued(entry.id);
            this.queueFailNotified.delete(entry.id);
            appendEvent({ at: now, kind: 'queue-fired', title: label, detail: entry.prompt.slice(0, 120) });
            void notify('Houston', `Sent queued prompt to "${label}".`, `queue-${entry.id}`);
          } else if (!this.queueFailNotified.has(entry.id)) {
            this.queueFailNotified.add(entry.id);
            void notify('Houston', `Couldn't type the queued prompt into "${label}" — its window wasn't reachable.`, `queuefail-${entry.id}`);
          }
        }
      }
    }

    // armed pause rules: at N% of the 5h window, gracefully interrupt the target
    // session (Esc/SIGINT — in-process subagents stop with it, transcript is kept)
    if (authority) {
      for (const rule of dueRules(usage.pct)) {
        const target = sessions.find((s) => s.sessionId === rule.sessionId);
        removeRule(rule); // one-shot, consumed even if the session is gone
        if (!target || target.status === 'ended') continue;
        const targetLabel = target.intel?.title ?? target.name ?? target.sessionId.slice(0, 8);
        if (target.status === 'busy' && target.pid !== undefined) {
          const ok = interruptSession(target.pid);
          void notify(
            'Houston',
            ok
              ? `Paused "${targetLabel}" at ~${usage.pct}% of the 5h limit — work so far is saved; type continue (or schedule) to resume.`
              : `Tried to pause "${targetLabel}" at ~${usage.pct}% but couldn't signal it.`,
            `pause-${rule.sessionId}-${rule.createdAt}`,
          );
          this.emit('paused', { sessionId: rule.sessionId, label: targetLabel, pct: usage.pct });
        } else {
          void notify('Houston', `"${targetLabel}" reached the ${rule.pct}% pause point but was already idle — nothing to stop.`, `pause-${rule.sessionId}-${rule.createdAt}`);
        }
      }
    }

    // one warning per climb past 80%; re-arms once the window drains below 70%
    if (usage.pct !== undefined) {
      if (usage.pct >= 80 && !this.warned80) {
        this.warned80 = true;
        if (authority) void notify('Houston', `5h usage at ~${usage.pct}% of the calibrated cap.`, `usage80-${Math.floor(Date.now() / 3600_000)}`);
      } else if (usage.pct < 70) {
        this.warned80 = false;
      }
    }
  }

  private syncTranscriptWatchers(sessions: Session[]): void {
    if (!this.transcriptWatcher) return;
    const wanted = new Set(
      sessions.filter((s) => s.status !== 'ended' && s.transcriptPath).map((s) => s.transcriptPath!),
    );
    for (const file of wanted) {
      if (!this.watchedTranscripts.has(file)) {
        this.transcriptWatcher.add(file);
        this.watchedTranscripts.add(file);
      }
    }
    for (const file of this.watchedTranscripts) {
      if (!wanted.has(file)) {
        this.transcriptWatcher.unwatch(path.resolve(file));
        this.watchedTranscripts.delete(file);
      }
    }
  }
}
