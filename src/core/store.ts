import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { sessionsDir, historyFile, ensureDirs } from './paths.js';
import { buildLiveSessions, buildProjects, sortSessions } from './snapshot.js';
import { readDismissals, isDismissed } from './dismissals.js';
import { readTimeline } from './historyReader.js';
import { AlertTracker } from './alerts.js';
import { GraphifyBridge } from './graphifyBridge.js';
import { pendingSchedules, fireDueSchedules } from './scheduler.js';
import type { Session, Snapshot } from './types.js';

const DEBOUNCE_MS = 100;
const LIVENESS_POLL_MS = 5000;
const SCHEDULE_POLL_MS = 30_000;
const HIDE_ENDED_AFTER_MS = 24 * 3600_000;

// Single source of truth for the TUI: watches Claude Code's on-disk state and emits
// debounced `snapshot` events. Tombstones live here because "ended gracefully" is only
// observable as a registry-file unlink — the disk forgets, we remember.
export class SessionStore extends EventEmitter {
  readonly graphify = new GraphifyBridge();
  snapshot?: Snapshot;

  private prevSessions = new Map<string, Session>();
  private tombstones = new Map<string, Session>();
  private alertTracker = new AlertTracker();
  private watchers: FSWatcher[] = [];
  private transcriptWatcher?: FSWatcher;
  private watchedTranscripts = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private scheduleTimer?: NodeJS.Timeout;
  private refreshing = false;
  private pendingRefresh = false;

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
    if (pendingSchedules().length === 0) return;
    const results = await fireDueSchedules(
      (sessionId) => this.prevSessions.get(sessionId)?.pid,
    );
    for (const result of results) this.emit('schedule-fired', result);
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
