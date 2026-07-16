import { describe, expect, test } from 'vitest';
import { cwdToProjectDirName } from '../src/core/paths.js';
import { windowFor, contextPct } from '../src/core/contextMeter.js';
import { riskyFiles } from '../src/core/gitOps.js';
import { parseHeadlessJson } from '../src/core/headless.js';

describe('cwdToProjectDirName', () => {
  test('maps home dir like Claude Code does', () => {
    expect(cwdToProjectDirName('/Users/ahaan')).toBe('-Users-ahaan');
  });

  test('maps dotted paths (every non-alphanumeric becomes a dash)', () => {
    expect(cwdToProjectDirName('/Users/ahaan/.Trash/regen-field-app')).toBe('-Users-ahaan--Trash-regen-field-app');
  });
});

describe('windowFor', () => {
  test('explicit [1m] tag in the model string wins', () => {
    expect(windowFor('claude-fable-5[1m]', 1000, undefined)).toBe(1_000_000);
  });

  test('settings model with [1m] upgrades a matching bare transcript model', () => {
    expect(windowFor('claude-fable-5', 1000, 'claude-fable-5[1m]')).toBe(1_000_000);
  });

  test('settings model does not upgrade a different model', () => {
    expect(windowFor('claude-haiku-4-5', 1000, 'claude-fable-5[1m]')).toBe(200_000);
  });

  test('tokens above 200k imply the long window even without tags', () => {
    expect(windowFor('claude-fable-5', 300_000, 'claude-fable-5')).toBe(1_000_000);
  });

  test('defaults to the standard window', () => {
    expect(windowFor('claude-fable-5', 50_000, 'claude-fable-5')).toBe(200_000);
  });
});

describe('contextPct', () => {
  test('computes and rounds', () => {
    expect(contextPct(100_000, 200_000)).toBe(50);
  });

  test('clamps to 100 — a mis-inferred window must never render >100%', () => {
    expect(contextPct(500_000, 200_000)).toBe(100);
  });

  test('handles zero window and zero tokens', () => {
    expect(contextPct(0, 200_000)).toBe(0);
    expect(contextPct(1000, 0)).toBe(0);
  });
});

describe('riskyFiles', () => {
  test('flags dotenv variants, keys, and certs', () => {
    const files = ['.env', '.env.local', 'server.pem', 'deploy.key', 'src/id_rsa', 'src/app.ts'];
    const risky = riskyFiles('/nonexistent-root', files);
    expect(risky).toContain('.env');
    expect(risky).toContain('.env.local');
    expect(risky).toContain('server.pem');
    expect(risky).toContain('deploy.key');
    expect(risky).toContain('src/id_rsa');
    expect(risky).not.toContain('src/app.ts');
  });

  test('does not flag lookalike source files', () => {
    expect(riskyFiles('/nonexistent-root', ['src/environment.ts', 'monkey.ts'])).toEqual([]);
  });
});

describe('parseHeadlessJson', () => {
  test('unwraps a string result containing JSON', () => {
    const stdout = JSON.stringify({ type: 'result', result: '{"subject":"feat: add login"}' });
    expect(parseHeadlessJson(stdout)).toEqual({ subject: 'feat: add login' });
  });

  test('unwraps an object result', () => {
    const stdout = JSON.stringify({ type: 'result', result: { done: ['a'], remaining: [] } });
    expect(parseHeadlessJson(stdout)).toEqual({ done: ['a'], remaining: [] });
  });

  test('prefers structured_output when present', () => {
    const stdout = JSON.stringify({ type: 'result', result: 'prose answer', structured_output: { subject: 'x' } });
    expect(parseHeadlessJson(stdout)).toEqual({ subject: 'x' });
  });

  test('returns undefined for prose-only results', () => {
    expect(parseHeadlessJson(JSON.stringify({ type: 'result', result: 'just words' }))).toBeUndefined();
  });

  test('survives junk before the envelope', () => {
    const stdout = `warning: something\n${JSON.stringify({ result: { ok: true } })}`;
    expect(parseHeadlessJson(stdout)).toEqual({ ok: true });
  });

  test('returns undefined on garbage', () => {
    expect(parseHeadlessJson('not json at all')).toBeUndefined();
  });
});

describe('matchCommand', () => {
  const commands = [
    { name: 'commit', aliases: ['c'], desc: '', run: () => {} },
    { name: 'push', aliases: ['p'], desc: '', run: () => {} },
    { name: 'graph', aliases: ['g'], desc: '', run: () => {} },
    { name: 'graph force', desc: '', run: () => {} },
    { name: 'quit', aliases: ['q', 'exit'], desc: '', run: () => {} },
    { name: 'stop', desc: '', available: false, run: () => {} },
  ];

  test('exact name wins', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'commit').exact?.name).toBe('commit');
  });

  test('single-letter alias still works', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'c').exact?.name).toBe('commit');
    expect(matchCommand(commands as any, 'q').exact?.name).toBe('quit');
  });

  test('unique prefix resolves', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'pu').exact?.name).toBe('push');
    expect(matchCommand(commands as any, 'com').exact?.name).toBe('commit');
  });

  test('exact "graph" beats the "graph force" prefix overlap', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'graph').exact?.name).toBe('graph');
    expect(matchCommand(commands as any, 'graph f').exact?.name).toBe('graph force');
  });

  test('unavailable commands are never matched', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'stop').exact).toBeUndefined();
  });

  test('case-insensitive', async () => {
    const { matchCommand } = await import('../src/tui/components/commandBar.js');
    expect(matchCommand(commands as any, 'COMMIT').exact?.name).toBe('commit');
  });
});
