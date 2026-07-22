import { describe, expect, test } from 'vitest';
import { UsageTracker, recordTokens } from '../src/core/usage.js';
import { nextQueuedFor } from '../src/core/queue.js';
import { dueRules } from '../src/core/pauses.js';
import type { QueueEntry } from '../src/core/types.js';

describe('recordTokens', () => {
  test('sums new-work tokens from assistant usage, ignoring cache reads', () => {
    const rec = {
      type: 'assistant',
      message: { usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 90000 } },
    };
    expect(recordTokens(rec)).toBe(1700);
  });

  test('non-assistant and usage-less records count zero', () => {
    expect(recordTokens({ type: 'user', message: { content: 'hi' } })).toBe(0);
    expect(recordTokens({ type: 'assistant', message: {} })).toBe(0);
  });
});

describe('UsageTracker window math', () => {
  test('tokens inside the 5h window count, older ones do not', () => {
    const t = new UsageTracker();
    const now = Date.now();
    t.addRecord(now - 60_000, 1000, false, now); // 1 min ago
    t.addRecord(now - 4 * 3600_000, 2000, false, now); // 4h ago — in window
    t.addRecord(now - 6 * 3600_000, 5000, false, now); // 6h ago — outside
    expect(t.windowTokens(now)).toBe(3000);
  });

  test('the window slides — old buckets fall out', () => {
    const t = new UsageTracker();
    const now = Date.now();
    t.addRecord(now - 4.9 * 3600_000, 1000, false, now);
    expect(t.windowTokens(now)).toBe(1000);
    expect(t.windowTokens(now + 30 * 60_000)).toBe(0); // 30 min later it aged out
  });

  test('summary without calibration reports absolute tokens, no percentage invented', () => {
    const t = new UsageTracker();
    const now = Date.now();
    t.addRecord(now, 12345, false, now);
    const s = t.summary(now);
    expect(s.windowTokens).toBe(12345);
    // pct may exist only if this machine already has a real calibration file — but it
    // must never be fabricated from nothing when windowTokens is tiny relative to caps
    if (!s.calibrated) expect(s.pct).toBeUndefined();
  });
});

describe('nextQueuedFor', () => {
  const q = (id: string, sessionId: string, createdAt: number): QueueEntry => ({ id, sessionId, prompt: 'p', createdAt });

  test('oldest entry for the session wins (FIFO)', () => {
    const entries = [q('b', 's1', 200), q('a', 's1', 100), q('c', 's2', 50)];
    expect(nextQueuedFor('s1', entries)?.id).toBe('a');
  });

  test('no entries → undefined', () => {
    expect(nextQueuedFor('s9', [])).toBeUndefined();
  });
});

describe('dueRules', () => {
  const rules = [
    { sessionId: 's1', pct: 50, createdAt: 1 },
    { sessionId: 's2', pct: 80, createdAt: 2 },
  ];

  test('fires rules at or below the current percentage', () => {
    expect(dueRules(55, rules).map((r) => r.sessionId)).toEqual(['s1']);
    expect(dueRules(90, rules).map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  test('uncalibrated meter (pct undefined) fires nothing', () => {
    expect(dueRules(undefined, rules)).toEqual([]);
  });
});
