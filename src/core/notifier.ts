import { execa } from 'execa';

// argv-based AppleScript: values never get interpolated into script source (no injection).
const NOTIFY_SCRIPT = `
on run argv
  display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
end run
`;

const RATE_LIMIT_MS = 10_000;
const lastNotified = new Map<string, number>();

export async function notify(title: string, body: string, dedupeKey?: string): Promise<void> {
  const key = dedupeKey ?? `${title}:${body}`;
  const now = Date.now();
  if ((lastNotified.get(key) ?? 0) > now - RATE_LIMIT_MS) return;
  lastNotified.set(key, now);
  try {
    await execa('osascript', ['-e', NOTIFY_SCRIPT, title, body.slice(0, 200)], { timeout: 10_000 });
  } catch {
    // notifications are best-effort
  }
}
