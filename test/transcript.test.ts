import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readTailRecords, readHeadRecords, scanBackwards } from '../src/core/transcriptReader.js';
import { buildRecentTurns, isHumanPrompt } from '../src/core/transcriptIndex.js';
import { readTimeline } from '../src/core/historyReader.js';

let dir: string;
let transcript: string;
let history: string;

const records = [
  { type: 'mode', mode: 'normal' },
  { type: 'user', message: { role: 'user', content: 'build me a login page' } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [
        { type: 'text', text: 'Sure, starting with the form.' },
        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/login.tsx' } },
      ],
      usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
    },
  },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'x' }] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta-injected context' } },
  { type: 'ai-title', aiTitle: 'Login page build' },
  { type: 'user', message: { role: 'user', content: 'now add validation' } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'Added zod validation.' }],
      usage: { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 2000, cache_creation_input_tokens: 10 },
    },
  },
  { type: 'last-prompt', lastPrompt: 'now add validation' },
];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-test-'));
  transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  history = path.join(dir, 'history.jsonl');
  const historyLines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ display: `prompt ${i}`, timestamp: 1000 + i, project: '/tmp/p', sessionId: `s${i}` }),
  );
  fs.writeFileSync(history, historyLines.join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('transcriptReader', () => {
  test('readTailRecords parses every full line', async () => {
    const tail = await readTailRecords(transcript);
    expect(tail).toHaveLength(records.length);
  });

  test('readTailRecords drops the partial first line when byte-capped', async () => {
    const tail = await readTailRecords(transcript, 200);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(records.length);
    expect(tail[tail.length - 1].type).toBe('last-prompt');
  });

  test('scanBackwards finds the LATEST record of each wanted type', async () => {
    const found = await scanBackwards(transcript, ['ai-title', 'last-prompt', 'assistant'], { chunkBytes: 128 });
    expect((found.get('ai-title') as any)?.aiTitle).toBe('Login page build');
    expect((found.get('last-prompt') as any)?.lastPrompt).toBe('now add validation');
    const assistant = found.get('assistant') as any;
    expect(assistant?.message?.usage?.cache_read_input_tokens).toBe(2000);
  });

  test('readHeadRecords reads from the start', async () => {
    const head = await readHeadRecords(transcript, 4096);
    expect(head[0].type).toBe('mode');
  });
});

describe('transcriptIndex', () => {
  test('isHumanPrompt: string content yes, tool_result no, isMeta no', () => {
    expect(isHumanPrompt(records[1] as any)).toBe(true);
    expect(isHumanPrompt(records[3] as any)).toBe(false);
    expect(isHumanPrompt(records[4] as any)).toBe(false);
  });

  test('buildRecentTurns extracts readable turns with tools', async () => {
    const tail = await readTailRecords(transcript);
    const turns = buildRecentTurns(tail, 10);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[1].tools).toEqual(['Write(/tmp/login.tsx)']);
    expect(turns[2].text).toBe('now add validation');
  });
});

describe('historyReader', () => {
  test('returns newest-first entries', async () => {
    const timeline = await readTimeline(3, history);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].prompt).toBe('prompt 4');
    expect(timeline[2].prompt).toBe('prompt 2');
  });
});
