import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';
import type { Session } from './types.js';

const dismissedFile = path.join(houstonDir, 'dismissed.json');
// dismissals only need to outlive the 24h ended-card window; prune beyond that
const PRUNE_AFTER_MS = 7 * 24 * 3600_000;

export function readDismissals(): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(dismissedFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function dismissSession(sessionId: string, now = Date.now()): void {
  const all = readDismissals();
  const pruned: Record<string, number> = {};
  for (const [id, at] of Object.entries(all)) {
    if (typeof at === 'number' && now - at < PRUNE_AFTER_MS) pruned[id] = at;
  }
  pruned[sessionId] = now;
  fs.mkdirSync(houstonDir, { recursive: true });
  const tmp = `${dismissedFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2));
  fs.renameSync(tmp, dismissedFile);
}

// A completed card stays hidden only while nothing new happened: any activity after
// the dismissal (new prompt, transcript write) brings the session back to the board.
export function isDismissed(session: Session, dismissals: Record<string, number>): boolean {
  const dismissedAt = dismissals[session.sessionId];
  if (dismissedAt === undefined) return false;
  const lastSeen = session.lastActivityAt ?? session.statusUpdatedAt ?? session.endedAt ?? session.startedAt ?? 0;
  return lastSeen <= dismissedAt;
}
