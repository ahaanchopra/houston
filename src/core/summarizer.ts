import fs from 'node:fs';
import path from 'node:path';
import { summaryCacheDir } from './paths.js';
import { readTailRecords, readHeadRecords } from './transcriptReader.js';
import { buildRecentTurns, isHumanPrompt } from './transcriptIndex.js';
import { runHaikuJson } from './headless.js';
import type { Summary } from './types.js';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    remaining: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    currentFocus: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['done', 'remaining', 'currentFocus'],
};

export interface SummaryTarget {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  title?: string;
}

export interface CachedSummary {
  key: string;
  summary: Summary;
  generatedAt: number;
  costUsd?: number;
}

const inFlight = new Map<string, Promise<CachedSummary>>();

export function cachedSummary(sessionId: string, transcriptPath?: string): CachedSummary | undefined {
  try {
    const cached: CachedSummary = JSON.parse(
      fs.readFileSync(path.join(summaryCacheDir, `${sessionId}.json`), 'utf8'),
    );
    if (!transcriptPath) return cached;
    const stat = fs.statSync(transcriptPath);
    return cached.key === `${stat.mtimeMs}:${stat.size}` ? cached : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

export async function summarize(target: SummaryTarget, opts: { refresh?: boolean } = {}): Promise<CachedSummary> {
  if (!target.transcriptPath) throw new Error('No transcript found for this session yet.');
  if (!opts.refresh) {
    const hit = cachedSummary(target.sessionId, target.transcriptPath);
    if (hit) return hit;
  }
  const existing = inFlight.get(target.sessionId);
  if (existing) return existing;
  const job = doSummarize(target).finally(() => inFlight.delete(target.sessionId));
  inFlight.set(target.sessionId, job);
  return job;
}

async function doSummarize(target: SummaryTarget): Promise<CachedSummary> {
  const transcriptPath = target.transcriptPath!;
  const stat = fs.statSync(transcriptPath);
  const [tail, head] = await Promise.all([
    readTailRecords(transcriptPath, 131072),
    readHeadRecords(transcriptPath),
  ]);

  // The tail alone can be one giant tool_result — always anchor on the original task.
  let firstPrompt = '';
  for (const rec of head as any[]) {
    if (isHumanPrompt(rec)) {
      firstPrompt = String(rec.message.content).slice(0, 2000);
      break;
    }
  }
  const turns = buildRecentTurns(tail, 20, 400);
  const excerpt = turns
    .map((t) =>
      t.role === 'user'
        ? `USER: ${t.text}`
        : `ASSISTANT: ${t.text}${t.tools.length ? `\n  tools: ${t.tools.join(', ')}` : ''}`,
    )
    .join('\n');

  const prompt = [
    'You are summarizing a Claude Code session transcript for a status dashboard used by a beginner.',
    `Session title: ${target.title ?? '(untitled)'}`,
    `Project: ${target.cwd}`,
    firstPrompt ? `Original task (first user prompt):\n${firstPrompt}` : '',
    `Most recent turns:\n${excerpt}`,
    'Return ONLY JSON matching the schema: what is DONE, what REMAINS, the current focus, any blockers.',
    'Short plain-English bullets, no jargon.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { payload, costUsd } = await runHaikuJson(prompt, SUMMARY_SCHEMA);
  if (!payload || !Array.isArray(payload.done) || !Array.isArray(payload.remaining)) {
    throw new Error('Summarizer returned no usable JSON.');
  }
  const cached: CachedSummary = {
    key: `${stat.mtimeMs}:${stat.size}`,
    summary: payload as Summary,
    generatedAt: Date.now(),
    costUsd,
  };
  fs.mkdirSync(summaryCacheDir, { recursive: true });
  fs.writeFileSync(path.join(summaryCacheDir, `${target.sessionId}.json`), JSON.stringify(cached, null, 2));
  return cached;
}
