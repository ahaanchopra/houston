import { describe, expect, test } from 'vitest';
import { isLimitRecord, parseResetTime, findActiveLimit } from '../src/core/limits.js';
import { parseTimeSpec } from '../src/core/scheduler.js';
import { sortSessions } from '../src/core/snapshot.js';
import { isDismissed } from '../src/core/dismissals.js';
import { parseCardNumber } from '../src/tui/components/commandBar.js';
import type { Session } from '../src/core/types.js';

// Shape verified against real transcripts: model "<synthetic>", error "rate_limit".
function limitRecord(text: string, timestamp: string) {
  return {
    type: 'assistant',
    timestamp,
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  };
}

const realAssistant = {
  type: 'assistant',
  message: { model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'done.' }] },
};

const humanPrompt = { type: 'user', message: { role: 'user', content: 'continue' } };

describe('isLimitRecord', () => {
  test('matches the synthetic rate_limit record', () => {
    expect(isLimitRecord(limitRecord("You've hit your session limit · resets 8:10pm (Asia/Calcutta)", '2026-07-21T13:35:08.624Z'))).toBe(true);
  });

  test('ignores real assistant messages and other API errors', () => {
    expect(isLimitRecord(realAssistant)).toBe(false);
    expect(
      isLimitRecord({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }] },
      }),
    ).toBe(false);
  });
});

describe('parseResetTime', () => {
  const hitAt = new Date(2026, 6, 21, 2, 0).getTime(); // 2:00am local

  test('parses "resets 7:30am" as the next 7:30am after the hit', () => {
    const at = parseResetTime("You've hit your session limit · resets 7:30am (Asia/Calcutta)", hitAt)!;
    const d = new Date(at);
    expect([d.getHours(), d.getMinutes()]).toEqual([7, 30]);
    expect(at).toBeGreaterThan(hitAt);
    expect(at - hitAt).toBeLessThan(24 * 3600_000);
  });

  test('a wall-clock time earlier than the hit rolls to the next day', () => {
    const at = parseResetTime('resets 1:20am', hitAt)!;
    expect(at - hitAt).toBeGreaterThan(20 * 3600_000); // 1:20am tomorrow, not today
  });

  test('handles pm and missing minutes', () => {
    const at = parseResetTime('resets 8pm', hitAt)!;
    expect(new Date(at).getHours()).toBe(20);
  });

  test('returns undefined when no reset time is present', () => {
    expect(parseResetTime('usage limit reached', hitAt)).toBeUndefined();
  });
});

describe('findActiveLimit', () => {
  const rec = limitRecord("You've hit your session limit · resets 7:30am (Asia/Calcutta)", '2026-07-21T20:30:00.000Z');

  test('limit at the end of the tail is active', () => {
    const limit = findActiveLimit([humanPrompt, realAssistant, rec]);
    expect(limit).toBeDefined();
    expect(limit!.resetsAt).toBeDefined();
  });

  test('a later human prompt clears it — the user already moved on', () => {
    expect(findActiveLimit([rec, humanPrompt])).toBeUndefined();
  });

  test('a later real assistant reply clears it', () => {
    expect(findActiveLimit([rec, realAssistant])).toBeUndefined();
  });

  test('no limit record → undefined', () => {
    expect(findActiveLimit([humanPrompt, realAssistant])).toBeUndefined();
  });
});

describe('parseTimeSpec', () => {
  const now = new Date(2026, 6, 22, 2, 0).getTime(); // 2:00am local

  test('parses 7:30 as the coming 7:30am', () => {
    const at = parseTimeSpec('7:30', now)!;
    const d = new Date(at);
    expect([d.getHours(), d.getMinutes()]).toEqual([7, 30]);
    expect(at - now).toBeLessThan(6 * 3600_000);
  });

  test('a time already past today lands tomorrow', () => {
    const at = parseTimeSpec('1:00am', now)!;
    expect(at - now).toBeGreaterThan(22 * 3600_000);
  });

  test('24h and meridiem forms', () => {
    expect(new Date(parseTimeSpec('19:30', now)!).getHours()).toBe(19);
    expect(new Date(parseTimeSpec('7pm', now)!).getHours()).toBe(19);
    expect(new Date(parseTimeSpec('12am', now)!).getHours()).toBe(0);
  });

  test('bare digits without a colon: 1900 → 19:00, 730 → 7:30, 7 → 7:00', () => {
    const at1900 = new Date(parseTimeSpec('1900', now)!);
    expect([at1900.getHours(), at1900.getMinutes()]).toEqual([19, 0]);
    const at730 = new Date(parseTimeSpec('730', now)!);
    expect([at730.getHours(), at730.getMinutes()]).toEqual([7, 30]);
    const at7 = new Date(parseTimeSpec('7', now)!);
    expect([at7.getHours(), at7.getMinutes()]).toEqual([7, 0]);
    const at0730 = new Date(parseTimeSpec('0730', now)!);
    expect([at0730.getHours(), at0730.getMinutes()]).toEqual([7, 30]);
  });

  test('garbage is rejected', () => {
    expect(parseTimeSpec('yesterday', now)).toBeUndefined();
    expect(parseTimeSpec('25:00', now)).toBeUndefined();
    expect(parseTimeSpec('7:75', now)).toBeUndefined();
    expect(parseTimeSpec('2500', now)).toBeUndefined();
    expect(parseTimeSpec('1975', now)).toBeUndefined();
  });
});

function session(partial: Partial<Session>): Session {
  return { sessionId: 's', cwd: '/tmp', status: 'idle', ...partial };
}

describe('isDismissed', () => {
  const now = Date.now();

  test('a completed card with no activity since stays hidden', () => {
    const s = session({ lastActivityAt: now - 60_000 });
    expect(isDismissed(s, { [s.sessionId]: now })).toBe(true);
  });

  test('new activity after completion brings the card back', () => {
    const s = session({ lastActivityAt: now });
    expect(isDismissed(s, { [s.sessionId]: now - 60_000 })).toBe(false);
  });

  test('sessions never completed are visible', () => {
    expect(isDismissed(session({ lastActivityAt: now }), {})).toBe(false);
  });

  test('ended cards fall back to endedAt for the comparison', () => {
    const s = session({ status: 'ended', endedAt: now - 3600_000 });
    expect(isDismissed(s, { [s.sessionId]: now })).toBe(true);
  });
});

describe('parseCardNumber', () => {
  test('digits and word numbers both resolve', () => {
    expect(parseCardNumber('1')).toBe(1);
    expect(parseCardNumber('12')).toBe(12);
    expect(parseCardNumber('one')).toBe(1);
    expect(parseCardNumber('Two')).toBe(2);
    expect(parseCardNumber('ten')).toBe(10);
  });

  test('non-numbers are rejected', () => {
    expect(parseCardNumber('continue')).toBeUndefined();
    expect(parseCardNumber('1st')).toBeUndefined();
    expect(parseCardNumber('')).toBeUndefined();
    expect(parseCardNumber(undefined)).toBeUndefined();
  });
});

describe('sortSessions with limited', () => {
  test('limited ranks between busy and idle', () => {
    const sorted = sortSessions([
      session({ sessionId: 'a', status: 'idle' }),
      session({ sessionId: 'b', status: 'limited' }),
      session({ sessionId: 'c', status: 'busy' }),
      session({ sessionId: 'd', status: 'ended' }),
    ]);
    expect(sorted.map((s) => s.status)).toEqual(['busy', 'limited', 'idle', 'ended']);
  });
});
