import type { JsonlRecord } from './transcriptReader.js';
import type { LimitInfo } from './types.js';

// When Claude Code hits a usage limit it writes a synthetic assistant record to the
// transcript: model "<synthetic>", error "rate_limit", apiErrorStatus 429, and a text
// block like "You've hit your session limit · resets 8:10pm (Asia/Calcutta)".
export function isLimitRecord(rec: JsonlRecord): boolean {
  const anyRec = rec as any;
  if (rec.type !== 'assistant') return false;
  if (anyRec.error === 'rate_limit') return true;
  return anyRec.isApiErrorMessage === true && /hit your .*limit/i.test(limitText(rec) ?? '');
}

export function limitText(rec: JsonlRecord): string | undefined {
  const content = (rec as any).message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

// "resets 8:10pm (Asia/Calcutta)" → the next epoch after hitAt with that wall-clock
// time. The timezone in parens is assumed to be the machine's own — Claude Code prints
// the local zone, so this holds unless the transcript crossed a timezone change.
export function parseResetTime(text: string, hitAt: number): number | undefined {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return undefined;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (hours > 23 || minutes > 59) return undefined;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  const at = new Date(hitAt);
  at.setHours(hours, minutes, 0, 0);
  // the reset is always in the future relative to when the limit was hit
  if (at.getTime() <= hitAt) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// Walk the transcript tail: the limit is ACTIVE only if nothing meaningful happened
// after it — a later human prompt or a real (non-error) assistant reply means the
// session already moved on.
export function findActiveLimit(tail: JsonlRecord[]): LimitInfo | undefined {
  let limit: LimitInfo | undefined;
  for (const rec of tail) {
    const anyRec = rec as any;
    if (isLimitRecord(rec)) {
      const message = limitText(rec) ?? 'usage limit reached';
      const hitAt = Date.parse(anyRec.timestamp ?? '') || Date.now();
      limit = { message, hitAt, resetsAt: parseResetTime(message, hitAt) };
      continue;
    }
    const isHuman = rec.type === 'user' && typeof anyRec.message?.content === 'string' && !anyRec.isMeta;
    const isRealAssistant = rec.type === 'assistant' && !anyRec.isApiErrorMessage;
    if (isHuman || isRealAssistant) limit = undefined;
  }
  return limit;
}
