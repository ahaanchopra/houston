import fs from 'node:fs';
import path from 'node:path';
import { houstonDir } from './paths.js';
import type { HoustonConfig } from './types.js';

const configFile = path.join(houstonDir, 'config.json');

export function readConfig(): HoustonConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function writeConfig(patch: Partial<HoustonConfig>): HoustonConfig {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(houstonDir, { recursive: true });
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, configFile);
  return next;
}
