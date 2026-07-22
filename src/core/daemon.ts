import { SessionStore } from './store.js';
import { writeDaemonLock, removeDaemonLock, daemonAlive } from './daemonLock.js';
import { maybeWriteDigest } from './digest.js';
import { ensureDirs } from './paths.js';

const DIGEST_CHECK_MS = 60_000;

// Headless houston: the SessionStore already does everything (watchers, alerts,
// scheduler, queue, usage meter) — the daemon just keeps one alive without Ink, adds
// the daily digest tick, and holds the lock that makes it the sole firer.
export async function runDaemon(): Promise<void> {
  if (daemonAlive()) {
    console.error('[houston] another daemon is already running — nothing to do.');
    process.exit(1);
  }
  ensureDirs();
  writeDaemonLock();
  const store = new SessionStore({ actor: 'daemon' });
  store.on('error', () => {}); // an unhandled 'error' event would crash the daemon

  const shutdown = () => {
    store.stop();
    removeDaemonLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => removeDaemonLock());

  store.start();
  const digestTimer = setInterval(() => {
    void maybeWriteDigest(store.snapshot, store.usage).catch(() => {});
  }, DIGEST_CHECK_MS);
  digestTimer.unref?.();

  console.log(`[houston] daemon running (pid ${process.pid}) — schedules, queue, alerts and the digest fire even with the TUI closed.`);
  // keep the event loop alive forever (watchers are unref-safe; this is the anchor)
  setInterval(() => {}, 2 ** 30);
}
