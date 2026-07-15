import { describe, expect, test, vi } from 'vitest';
import { AlertTracker } from '../src/core/alerts.js';
import type { Session } from '../src/core/types.js';

function session(overrides: Partial<Session>): Session {
  return {
    sessionId: 'abc',
    cwd: '/tmp/p',
    status: 'idle',
    ...overrides,
  };
}

describe('AlertTracker', () => {
  test('busy→idle after a long busy phase fires needs-input once', () => {
    const notify = vi.fn(async () => {});
    const tracker = new AlertTracker(notify as any);

    const busy = session({ status: 'busy' });
    tracker.update(new Map(), [busy]);

    // simulate the busy phase having started 60s ago
    (tracker as any).busySince.set('abc', Date.now() - 60_000);
    const idle = session({ status: 'idle', statusUpdatedAt: Date.now() });
    const alerts = tracker.update(new Map([['abc', busy]]), [idle]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('needs-input');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('quick conversational busy→idle does NOT alert', () => {
    const notify = vi.fn(async () => {});
    const tracker = new AlertTracker(notify as any);
    const busy = session({ status: 'busy' });
    tracker.update(new Map(), [busy]); // busySince = now
    const idle = session({ status: 'idle' });
    const alerts = tracker.update(new Map([['abc', busy]]), [idle]);
    expect(alerts).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('live→ended fires finished (but not for houston children)', () => {
    const notify = vi.fn(async () => {});
    const tracker = new AlertTracker(notify as any);
    const busy = session({ status: 'busy' });
    const ended = session({ status: 'ended' });
    const alerts = tracker.update(new Map([['abc', busy]]), [ended]);
    expect(alerts.map((a) => a.kind)).toEqual(['finished']);

    const child = session({ sessionId: 'run:1', status: 'ended', isHoustonChild: true });
    const before = session({ sessionId: 'run:1', status: 'busy', isHoustonChild: true });
    const childAlerts = tracker.update(new Map([['run:1', before]]), [child]);
    expect(childAlerts.filter((a) => a.sessionId === 'run:1')).toHaveLength(0);
  });

  test('stale busy sessions get flagged maybeWaiting', () => {
    const tracker = new AlertTracker(vi.fn(async () => {}) as any);
    const stale = session({ status: 'busy', statusUpdatedAt: Date.now() - 300_000 });
    tracker.update(new Map(), [stale]);
    expect(stale.maybeWaiting).toBe(true);

    const fresh = session({ sessionId: 'def', status: 'busy', statusUpdatedAt: Date.now() });
    tracker.update(new Map(), [fresh]);
    expect(fresh.maybeWaiting).toBe(false);
  });

  test('dismiss removes alerts for a session', () => {
    const tracker = new AlertTracker(vi.fn(async () => {}) as any);
    const busy = session({ status: 'busy' });
    const ended = session({ status: 'ended' });
    tracker.update(new Map([['abc', busy]]), [ended]);
    tracker.dismiss('abc');
    const alerts = tracker.update(new Map([['abc', ended]]), [ended]);
    expect(alerts).toHaveLength(0);
  });
});
