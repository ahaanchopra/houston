import { describe, expect, test } from 'vitest';
import { matchCommand, type WordCommand } from '../src/tui/components/commandBar.js';

const noop = () => {};
// mirrors the dashboard's registration order for the prefixes under test
const COMMANDS: WordCommand[] = [
  { name: 'commit', aliases: ['c'], desc: '', run: noop },
  { name: 'push', aliases: ['p'], desc: '', run: noop },
  { name: 'summarize', aliases: ['s'], desc: '', run: noop },
  { name: 'stop', aliases: ['x'], desc: '', run: noop },
  { name: 'schedule', aliases: ['at'], takesArgs: true, desc: '', run: noop },
  { name: 'complete', aliases: ['done'], takesArgs: true, desc: '', run: noop },
  { name: 'graph', aliases: ['g'], desc: '', run: noop },
  { name: 'graphify', takesArgs: true, desc: '', run: noop },
  { name: 'quit', aliases: ['q'], desc: '', run: noop },
];

describe('matchCommand auto-recommend', () => {
  test('ambiguous prefix recommends the first registered match: co → commit', () => {
    const { best, matches } = matchCommand(COMMANDS, 'co');
    expect(best?.name).toBe('commit');
    expect(matches.map((m) => m.name)).toEqual(['commit', 'complete']);
  });

  test('exact alias beats prefix ranking: s → summarize (alias), not schedule', () => {
    expect(matchCommand(COMMANDS, 's').best?.name).toBe('summarize');
  });

  test('gr recommends graph (registered first), graphi narrows to graphify', () => {
    expect(matchCommand(COMMANDS, 'gr').best?.name).toBe('graph');
    expect(matchCommand(COMMANDS, 'graphi').best?.name).toBe('graphify');
  });

  test('partial head word with args still resolves: sch 1900 2', () => {
    const { best, args } = matchCommand(COMMANDS, 'sch 1900 2');
    expect(best?.name).toBe('schedule');
    expect(args).toBe('1900 2');
  });

  test('args only reach takesArgs commands: comm 123 → no match (commit takes none)', () => {
    expect(matchCommand(COMMANDS, 'comm 123').best).toBeUndefined();
  });

  test('garbage has no recommendation', () => {
    expect(matchCommand(COMMANDS, 'zzz').best).toBeUndefined();
    expect(matchCommand(COMMANDS, 'zzz 1').best).toBeUndefined();
  });
});
