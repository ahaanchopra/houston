import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';
import type { QueueEntry } from './types.js';

// Queued prompts: "when this session next goes idle, type this in". FIFO per session,
// persisted so the daemon (or a restarted TUI) can send them.

const queueFile = path.join(houstonDir, 'queue.json');

export function listQueue(): QueueEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveQueue(entries: QueueEntry[]): void {
  fs.mkdirSync(houstonDir, { recursive: true });
  const tmp = `${queueFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, queueFile);
}

export function addQueued(input: { sessionId: string; agent?: 'claude' | 'codex'; prompt: string }): QueueEntry {
  const entry: QueueEntry = {
    id: `q-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    sessionId: input.sessionId,
    agent: input.agent,
    prompt: input.prompt,
    createdAt: Date.now(),
  };
  saveQueue([...listQueue(), entry]);
  return entry;
}

// remove ALL queued prompts for a session (the unqueue command)
export function clearQueued(sessionId: string): number {
  const all = listQueue();
  const next = all.filter((e) => e.sessionId !== sessionId);
  if (next.length !== all.length) saveQueue(next);
  return all.length - next.length;
}

export function removeQueued(id: string): void {
  saveQueue(listQueue().filter((e) => e.id !== id));
}

// oldest queued prompt for a session — the one an idle transition should send
export function nextQueuedFor(sessionId: string, entries = listQueue()): QueueEntry | undefined {
  return entries
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}
