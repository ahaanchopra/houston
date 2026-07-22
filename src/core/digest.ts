import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { houstonDir, eventsFile } from './paths.js';
import { readConfig } from './config.js';
import { notify } from './notifier.js';
import type { Snapshot } from './types.js';
import type { UsageTracker } from './usage.js';

// Deterministic morning digest — no LLM. Aggregates the last 24h from the events log,
// git commits across known project roots, and the daily token counter.

const digestsDir = path.join(houstonDir, 'digests');

export interface HoustonEvent {
  at: number;
  kind: 'ended' | 'limit-hit' | 'schedule-fired' | 'queue-fired';
  title?: string;
  detail?: string;
}

export function appendEvent(event: HoustonEvent): void {
  try {
    fs.mkdirSync(houstonDir, { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
  } catch {
    // the log is best-effort
  }
}

function readEventsSince(cutoff: number): HoustonEvent[] {
  try {
    return fs
      .readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as HoustonEvent;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is HoustonEvent => Boolean(e && e.at >= cutoff));
  } catch {
    return [];
  }
}

// core stays independent of the TUI theme — tiny local formatter
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n || 0);
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function latestDigestPath(): string | undefined {
  try {
    const files = fs.readdirSync(digestsDir).filter((f) => f.endsWith('.md')).sort();
    const last = files[files.length - 1];
    return last ? path.join(digestsDir, last) : undefined;
  } catch {
    return undefined;
  }
}

async function commitsSince24h(root: string): Promise<number> {
  try {
    const { stdout } = await execa('git', ['-C', root, 'log', '--oneline', '--since=24 hours ago'], { timeout: 10_000 });
    return stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

// Writes today's digest once the configured hour has passed. Returns the path when a
// new digest was written, undefined otherwise.
export async function maybeWriteDigest(
  snapshot: Snapshot | undefined,
  usage: UsageTracker,
  now = Date.now(),
): Promise<string | undefined> {
  const hour = readConfig().digestHour ?? 9;
  const d = new Date(now);
  if (d.getHours() < hour) return undefined;
  const today = localDay(now);
  const file = path.join(digestsDir, `${today}.md`);
  if (fs.existsSync(file)) return undefined;

  const events = readEventsSince(now - 24 * 3600_000);
  const ended = events.filter((e) => e.kind === 'ended');
  const limits = events.filter((e) => e.kind === 'limit-hit');
  const fired = events.filter((e) => e.kind === 'schedule-fired' || e.kind === 'queue-fired');
  const activeSessions = snapshot?.sessions.filter((s) => s.status !== 'ended') ?? [];

  let commitLines = '';
  let totalCommits = 0;
  for (const project of snapshot?.projects ?? []) {
    if (!project.isRepo) continue;
    const count = await commitsSince24h(project.root);
    totalCommits += count;
    if (count > 0) commitLines += `- ${project.root.split('/').pop()}: ${count} commit${count === 1 ? '' : 's'}\n`;
  }

  const yesterday = localDay(now - 24 * 3600_000);
  const tokens = usage.dailyTokens(today) + usage.dailyTokens(yesterday);

  const lines = [
    `# houston digest — ${today}`,
    '',
    `- sessions right now: ${activeSessions.length} active`,
    `- last 24h: ${ended.length} session${ended.length === 1 ? '' : 's'} ended · ${limits.length} limit hit${limits.length === 1 ? '' : 's'} · ${fired.length} auto-continue/queue send${fired.length === 1 ? '' : 's'}`,
    `- tokens (new work, ~24h): ${fmtTokens(tokens)}`,
    `- commits: ${totalCommits}`,
    commitLines ? `\n## commits by project\n${commitLines}` : '',
    limits.length > 0 ? `\n## limits hit\n${limits.map((e) => `- ${e.title ?? 'session'}${e.detail ? ` — ${e.detail}` : ''}`).join('\n')}\n` : '',
  ];
  fs.mkdirSync(digestsDir, { recursive: true });
  fs.writeFileSync(file, lines.filter(Boolean).join('\n'));
  void notify(
    'Houston digest',
    `${ended.length} ended · ${totalCommits} commits · ${fmtTokens(tokens)} tokens — type digest in houston`,
    `digest-${today}`,
  );
  return file;
}
