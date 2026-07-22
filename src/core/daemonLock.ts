import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';
import { isAlive } from './sessionRegistry.js';

// Single-firer rule: when a daemon is alive, the TUI renders everything but fires
// nothing (no schedules, no queue sends, no notifications) — otherwise both processes
// would double-fire. A stale lock (crashed daemon) fails isAlive and the TUI takes over.

const lockFile = path.join(houstonDir, 'daemon.lock');

export function writeDaemonLock(): void {
  fs.mkdirSync(houstonDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
}

export function removeDaemonLock(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (raw?.pid === process.pid) fs.unlinkSync(lockFile);
  } catch {
    // already gone
  }
}

export function daemonAlive(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return typeof raw?.pid === 'number' && raw.pid !== process.pid && isAlive(raw.pid);
  } catch {
    return false;
  }
}
