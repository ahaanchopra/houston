import { describe, expect, test } from 'vitest';
import { psQuote, escapeSendKeys, claudeSpawnCommand } from '../src/core/platform/win32.js';

describe('psQuote', () => {
  test('wraps in single quotes and doubles embedded ones', () => {
    expect(psQuote('C:\\Users\\ahaan')).toBe("'C:\\Users\\ahaan'");
    expect(psQuote("it's done")).toBe("'it''s done'");
  });

  test('neutralizes injection attempts — $ and ; stay literal inside single quotes', () => {
    expect(psQuote('$(Remove-Item x); &evil')).toBe("'$(Remove-Item x); &evil'");
  });
});

describe('escapeSendKeys', () => {
  test('brace-escapes SendKeys control characters', () => {
    expect(escapeSendKeys('a+b^c%d~e')).toBe('a{+}b{^}c{%}d{~}e');
    expect(escapeSendKeys('(x) [y] {z}')).toBe('{(}x{)} {[}y{]} {{}z{}}');
  });

  test('plain prompts pass through untouched', () => {
    expect(escapeSendKeys('continue')).toBe('continue');
    expect(escapeSendKeys('update graphify')).toBe('update graphify');
  });
});

describe('claudeSpawnCommand', () => {
  test('non-Windows passes through to claude directly', () => {
    // this test suite runs on macOS/Linux CI — isWindows is false here
    expect(claudeSpawnCommand(['-p', 'hi'])).toEqual({ cmd: 'claude', args: ['-p', 'hi'] });
  });
});
