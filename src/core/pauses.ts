import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';

// Armed pause rules: "when the 5h usage meter reaches N%, interrupt this session".
// Interrupt = the same graceful Esc/SIGINT the stop command sends — the current turn
// (and its in-process subagents, which live inside the same claude process) stop,
// everything already written to the transcript is kept, and the session resumes later
// with a typed "continue" or a schedule. One-shot: a rule is consumed when it fires.

export interface PauseRule {
  sessionId: string;
  pct: number;
  createdAt: number;
}

const pausesFile = path.join(houstonDir, 'pauses.json');

export function listPauseRules(): PauseRule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pausesFile, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveRules(rules: PauseRule[]): void {
  fs.mkdirSync(houstonDir, { recursive: true });
  const tmp = `${pausesFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2));
  fs.renameSync(tmp, pausesFile);
}

// one rule per session — a new threshold replaces the old
export function setPauseRule(sessionId: string, pct: number): PauseRule {
  const rule: PauseRule = { sessionId, pct, createdAt: Date.now() };
  saveRules([...listPauseRules().filter((r) => r.sessionId !== sessionId), rule]);
  return rule;
}

export function clearPauseRule(sessionId: string): boolean {
  const all = listPauseRules();
  const next = all.filter((r) => r.sessionId !== sessionId);
  if (next.length === all.length) return false;
  saveRules(next);
  return true;
}

export function removeRule(rule: PauseRule): void {
  saveRules(listPauseRules().filter((r) => !(r.sessionId === rule.sessionId && r.createdAt === rule.createdAt)));
}

export function dueRules(pct: number | undefined, rules = listPauseRules()): PauseRule[] {
  if (pct === undefined) return [];
  return rules.filter((r) => pct >= r.pct);
}
