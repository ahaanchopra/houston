import { describe, expect, test } from 'vitest';
import { codexIsBusy, codexFindLimit, buildCodexIntel, buildCodexTurns } from '../src/core/codex.js';

// record shapes verified against real ~/.codex rollouts (codex-cli 0.144.6)
const ev = (type: string, extra: object = {}) => ({ timestamp: '2026-07-22T10:00:00.000Z', type: 'event_msg', payload: { type, ...extra } });
const userMsg = (message: string) => ev('user_message', { message });
const agentMsg = (message: string) => ev('agent_message', { message });
const tokenCount = (input: number, output: number, window: number) =>
  ev('token_count', { info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output }, model_context_window: window } });

describe('codexIsBusy', () => {
  test('task_started with no completion = busy', () => {
    expect(codexIsBusy([userMsg('go'), ev('task_started', { turn_id: 't1' })])).toBe(true);
  });

  test('task_complete ends the turn', () => {
    expect(codexIsBusy([ev('task_started', {}), agentMsg('done'), ev('task_complete', {})])).toBe(false);
  });

  test('turn_aborted (Esc) also ends it', () => {
    expect(codexIsBusy([ev('task_started', {}), ev('turn_aborted', { reason: 'interrupted' })])).toBe(false);
  });
});

describe('buildCodexIntel', () => {
  test('extracts prompts, turns, tokens, window and model', () => {
    const intel = buildCodexIntel(
      [
        ev('thread_settings_applied', { thread_settings: { model: 'gpt-5.6-sol' } }),
        userMsg('first question'),
        agentMsg('answer'),
        userMsg('second question'),
        tokenCount(19564, 230, 258400),
      ],
      'My Thread',
    );
    expect(intel.title).toBe('My Thread');
    expect(intel.turns).toBe(2);
    expect(intel.firstPrompt).toBe('first question');
    expect(intel.lastPrompt).toBe('second question');
    expect(intel.model).toBe('gpt-5.6-sol');
    expect(intel.contextTokens).toBe(19794);
    expect(intel.window).toBe(258400);
  });
});

describe('codexFindLimit', () => {
  test('trailing usage-limit error marks the session limited', () => {
    const limit = codexFindLimit([userMsg('go'), ev('error', { message: "You've hit your usage limit. Try again later." })]);
    expect(limit).toBeDefined();
  });

  test('activity after the error clears it', () => {
    expect(codexFindLimit([ev('error', { message: 'usage limit reached' }), userMsg('continue')])).toBeUndefined();
  });
});

describe('buildCodexTurns', () => {
  test('user and agent messages become peek turns, tool calls attach to the agent', () => {
    const turns = buildCodexTurns([
      userMsg('check the graph'),
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent' } },
      agentMsg('spawned it'),
      agentMsg('and finished'),
    ]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1].tools).toEqual(['spawn_agent']);
    expect(turns[1].text).toContain('and finished');
  });
});
