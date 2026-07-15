import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { GitStatusInfo } from './types.js';

const NO_REPO: GitStatusInfo = { isRepo: false, dirtyFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0 };

const SECRET_PATTERNS = [/^\.env($|\.)/, /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/, /\.p12$/i, /\.keystore$/i];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const NODE_GITIGNORE = `node_modules/
dist/
build/
.env
.env.*
*.log
.DS_Store
`;

export async function gitStatus(root: string): Promise<GitStatusInfo> {
  try {
    const git = simpleGit(root);
    if (!(await git.checkIsRepo())) return { ...NO_REPO };
    const status = await git.status();
    let insertions = 0;
    let deletions = 0;
    try {
      const diff = await git.diffSummary();
      insertions = diff.insertions;
      deletions = diff.deletions;
    } catch {
      // fresh repo with no HEAD yet
    }
    let lastCommit: string | undefined;
    try {
      const log = await git.log({ maxCount: 1 });
      lastCommit = log.latest?.message;
    } catch {
      // no commits yet
    }
    return {
      isRepo: true,
      branch: status.current ?? undefined,
      dirtyFiles: status.files.length,
      insertions,
      deletions,
      ahead: status.ahead,
      behind: status.behind,
      lastCommit,
    };
  } catch {
    return { ...NO_REPO };
  }
}

// The classic vibe-coder disaster is auto-committing .env or a 200MB artifact — flag them.
export function riskyFiles(root: string, files: string[]): string[] {
  const risky: string[] = [];
  for (const file of files) {
    const base = path.basename(file);
    if (SECRET_PATTERNS.some((re) => re.test(base) || re.test(file))) {
      risky.push(file);
      continue;
    }
    try {
      if (fs.statSync(path.join(root, file)).size > MAX_FILE_BYTES) risky.push(file);
    } catch {
      // deleted file — nothing to size-check
    }
  }
  return risky;
}

// Stage FIRST, then diff --staged — generating the message before staging sees an empty diff.
export async function stageAllAndDiff(root: string): Promise<{ files: string[]; diff: string }> {
  const git = simpleGit(root);
  await git.add(['-A']);
  const status = await git.status();
  const files = status.files.map((f) => f.path);
  let diff = '';
  try {
    diff = await git.diff(['--staged']);
  } catch {
    // unborn HEAD — show file list only
  }
  return { files, diff: diff.slice(0, 60_000) };
}

export async function commitStaged(root: string, message: string): Promise<string> {
  const git = simpleGit(root);
  try {
    const res = await git.commit(message);
    return res.commit;
  } catch (err: any) {
    // an active Claude session may hold index.lock mid-turn — wait and retry once
    if (String(err?.message ?? '').includes('index.lock')) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const res = await git.commit(message);
      return res.commit;
    }
    throw err;
  }
}

export interface PushResult {
  ok: boolean;
  message: string;
  suggestion?: string;
}

export async function push(root: string): Promise<PushResult> {
  const git = simpleGit(root);
  try {
    await git.push();
    return { ok: true, message: 'Pushed to GitHub.' };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/no configured push destination/i.test(msg)) {
      return {
        ok: false,
        message: 'This project is not connected to GitHub yet.',
        suggestion: `Run: gh repo create --source "${root}" --private --push`,
      };
    }
    if (/no upstream|set-upstream/i.test(msg)) {
      try {
        await git.push(['-u', 'origin', 'HEAD']);
        return { ok: true, message: 'Pushed (and linked this branch to GitHub).' };
      } catch {
        return {
          ok: false,
          message: 'This branch is not linked to the remote yet.',
          suggestion: 'Run: git push -u origin HEAD',
        };
      }
    }
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(msg)) {
      return {
        ok: false,
        message: 'GitHub has newer commits than your machine.',
        suggestion: 'Run: git pull --rebase, then push again',
      };
    }
    return { ok: false, message: msg.split('\n').find((l) => l.trim()) ?? 'Push failed.' };
  }
}

export async function saveVersion(root: string, commitMessage?: string): Promise<string> {
  const git = simpleGit(root);
  const status = await git.status();
  if (status.files.length > 0) {
    await git.add(['-A']);
    await commitStaged(root, commitMessage ?? `savepoint: work in progress ${new Date().toLocaleString()}`);
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tag = `save-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  await git.addAnnotatedTag(tag, 'Houston save point');
  return tag;
}

export async function initRepo(root: string): Promise<void> {
  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, NODE_GITIGNORE);
  await simpleGit(root).init();
}
