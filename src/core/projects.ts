import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { projectsDir, cwdToProjectDirName } from './paths.js';

const repoRootCache = new Map<string, string>();

// Two sessions in different subdirs of one repo are the same project — key by repo root.
export async function repoRootFor(cwd: string): Promise<string> {
  const hit = repoRootCache.get(cwd);
  if (hit) return hit;
  let root = cwd;
  try {
    const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (stdout.trim()) root = stdout.trim();
  } catch {
    // not a repo — the cwd itself is the project
  }
  repoRootCache.set(cwd, root);
  return root;
}

export function transcriptPathFor(sessionId: string, cwd: string): string | undefined {
  const direct = path.join(projectsDir, cwdToProjectDirName(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // the dir-name mapping is undocumented — fall back to scanning for the sessionId
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // projects dir unreadable
  }
  return undefined;
}

export function hasGraphify(root: string): boolean {
  return fs.existsSync(path.join(root, 'graphify-out', 'graph.json'));
}
