import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const claudeDir = path.join(os.homedir(), '.claude');
export const sessionsDir = path.join(claudeDir, 'sessions');
export const projectsDir = path.join(claudeDir, 'projects');
export const historyFile = path.join(claudeDir, 'history.jsonl');
export const settingsFile = path.join(claudeDir, 'settings.json');

export const houstonDir = path.join(claudeDir, 'houston');
export const summaryCacheDir = path.join(houstonDir, 'cache', 'summaries');
export const runsDir = path.join(houstonDir, 'runs');
export const headlessCwd = path.join(houstonDir, 'headless');
export const tmpDir = path.join(houstonDir, 'tmp');
export const projectsFile = path.join(houstonDir, 'projects.json');
export const eventsFile = path.join(houstonDir, 'events.jsonl');

// Claude Code names transcript dirs by replacing every non-alphanumeric char of the cwd
// with '-' (verified: /Users/ahaan → -Users-ahaan, /Users/ahaan/.Trash/x → -Users-ahaan--Trash-x).
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function ensureDirs(): void {
  for (const dir of [houstonDir, summaryCacheDir, runsDir, headlessCwd, tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
