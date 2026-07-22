import { notify } from './notifier.js';
import type { Alert, Session } from './types.js';

// Only alert when the busy phase was long enough to mean "Claude worked while you were
// away" — quick conversational turns would otherwise spam a banner per reply.
const MIN_BUSY_MS = 45_000;
// busy but heartbeat stale ⇒ probably blocked on a permission prompt the user can't see.
const STALE_BUSY_MS = 120_000;
const ALERT_TTL_MS = 5 * 60_000;

type NotifyFn = typeof notify;

export class AlertTracker {
  private busySince = new Map<string, number>();
  private alerts: Alert[] = [];
  private notifyFn: NotifyFn;

  constructor(notifyFn: NotifyFn = notify) {
    this.notifyFn = notifyFn;
  }

  update(prev: Map<string, Session>, next: Session[]): Alert[] {
    const now = Date.now();
    for (const session of next) {
      const before = prev.get(session.sessionId);
      const label = session.intel?.title ?? session.name ?? session.sessionId.slice(0, 8);

      if (session.status === 'busy') {
        if (!this.busySince.has(session.sessionId)) this.busySince.set(session.sessionId, now);
      } else {
        const since = this.busySince.get(session.sessionId);
        this.busySince.delete(session.sessionId);
        if (
          before?.status === 'busy' &&
          session.status === 'idle' &&
          since !== undefined &&
          now - since >= MIN_BUSY_MS
        ) {
          this.alerts.push({ kind: 'needs-input', sessionId: session.sessionId, at: now, title: label });
          void this.notifyFn(
            'Houston',
            `"${label}" is waiting for your input`,
            `needs-${session.sessionId}-${session.statusUpdatedAt ?? now}`,
          );
        }
      }

      // a hit limit means the session silently stopped working — that MUST surface
      if (session.status === 'limited' && before?.status !== 'limited') {
        const resets = session.intel?.limit?.resetsAt;
        const when = resets
          ? ` — resets ${new Date(resets).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : '';
        this.alerts.push({ kind: 'limit-hit', sessionId: session.sessionId, at: now, title: label });
        void this.notifyFn(
          'Houston',
          `"${label}" hit its usage limit${when}. Type schedule to auto-continue it.`,
          `limit-${session.sessionId}-${session.intel?.limit?.hitAt ?? now}`,
        );
      }

      // background runs are user-initiated, so their completion IS the news
      if (before && before.status !== 'ended' && session.status === 'ended') {
        const what = session.isHoustonChild ? 'Background run' : 'Session';
        this.alerts.push({ kind: 'finished', sessionId: session.sessionId, at: now, title: label });
        void this.notifyFn('Houston', `${what} "${label}" ended`, `end-${session.sessionId}`);
      }

      const lastActivity = session.lastActivityAt ?? session.statusUpdatedAt;
      session.maybeWaiting =
        session.status === 'busy' && lastActivity !== undefined && now - lastActivity > STALE_BUSY_MS;
    }
    this.alerts = this.alerts.filter((a) => now - a.at < ALERT_TTL_MS);
    return [...this.alerts];
  }

  dismiss(sessionId: string): void {
    this.alerts = this.alerts.filter((a) => a.sessionId !== sessionId);
  }
}
