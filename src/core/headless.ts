import { execa } from 'execa';
import { headlessCwd } from './paths.js';

// All headless helpers run haiku with --safe-mode: it skips this machine's CLAUDE.md,
// skills, plugins, hooks AND MCP servers — cheap, fast, and no houston-mcp recursion.
const BASE_ARGS = ['-p', '--model', 'haiku', '--safe-mode', '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'dontAsk'];

export interface HeadlessResult {
  payload: any;
  costUsd?: number;
}

export async function runHaikuJson(
  prompt: string,
  schema: object,
  opts: { maxBudgetUsd?: string; timeoutMs?: number } = {},
): Promise<HeadlessResult> {
  const { stdout } = await execa(
    'claude',
    [...BASE_ARGS, '--max-budget-usd', opts.maxBudgetUsd ?? '0.10', '--json-schema', JSON.stringify(schema)],
    {
      input: prompt,
      cwd: headlessCwd,
      timeout: opts.timeoutMs ?? 90_000,
      env: { ...process.env, HOUSTON_CHILD: '1' },
    },
  );
  return { payload: parseHeadlessJson(stdout), costUsd: extractCost(stdout) };
}

// `claude -p --output-format json` prints an envelope; the schema-validated payload lives
// in `structured_output` or `result` (string or object) depending on CLI version.
export function parseHeadlessJson(stdout: string): any {
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    if (start === -1) return undefined;
    try {
      envelope = JSON.parse(stdout.slice(start));
    } catch {
      return undefined;
    }
  }
  for (const candidate of [envelope?.structured_output, envelope?.result]) {
    if (candidate == null) continue;
    if (typeof candidate === 'object') return candidate;
    if (typeof candidate === 'string') {
      try {
        return JSON.parse(candidate);
      } catch {
        // result was prose, not JSON — try next candidate
      }
    }
  }
  return undefined;
}

function extractCost(stdout: string): number | undefined {
  try {
    const cost = JSON.parse(stdout)?.total_cost_usd;
    return typeof cost === 'number' ? cost : undefined;
  } catch {
    return undefined;
  }
}
