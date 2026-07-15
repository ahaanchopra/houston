import fs from 'node:fs';
import { settingsFile } from './paths.js';

const STANDARD_WINDOW = 200_000;
const LONG_WINDOW = 1_000_000;

let settingsModel: string | undefined;
let settingsRead = false;

function readSettingsModel(): string | undefined {
  if (!settingsRead) {
    settingsRead = true;
    try {
      settingsModel = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model;
    } catch {
      // no settings — fall through to heuristics
    }
  }
  return settingsModel;
}

// Transcripts record the bare model id ("claude-fable-5") even when the session runs the
// 1m-context variant (settings say "claude-fable-5[1m]") — so the window must be inferred.
export function windowFor(
  model: string | undefined,
  contextTokens: number,
  settingsModelOverride?: string,
): number {
  if (model?.includes('[1m]')) return LONG_WINDOW;
  const fromSettings = settingsModelOverride ?? readSettingsModel();
  if (fromSettings?.includes('[1m]') && model && fromSettings.startsWith(model)) return LONG_WINDOW;
  if (contextTokens > STANDARD_WINDOW) return LONG_WINDOW;
  return STANDARD_WINDOW;
}

export function contextPct(contextTokens: number, window: number): number {
  if (!window || contextTokens <= 0) return 0;
  return Math.min(100, Math.round((contextTokens / window) * 100));
}
