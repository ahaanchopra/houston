import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

// compiled location is <root>/dist/core/selfUpdate.js — the install dir IS a git clone,
// so updating = pull + rebuild, same as re-running the curl installer.
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Git credential prompts open /dev/tty directly — the same terminal Ink holds in raw
// mode. Force non-interactive so auth problems fail fast instead of painting
// "Username for https://github.com:" over the dashboard.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

function git(root: string, args: string[], timeout: number) {
  return execa('git', ['-C', root, ...args], { timeout, env: GIT_ENV });
}

// The startup check and a user-typed `update` share one clone — serialize all git work
// so fetch and pull never race on the repo's lock files.
let gitQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitQueue.then(fn, fn);
  gitQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// A build stamp (HEAD commit at last successful build) — NOT "did pull move HEAD" —
// decides whether install+build must run. Otherwise a pull that succeeds but whose
// build fails leaves the user permanently stuck on a stale dist with "Already up to
// date." on every retry.
function stampFile(root: string): string {
  return path.join(root, 'dist', '.build-commit');
}

function readStamp(root: string): string {
  try {
    return fs.readFileSync(stampFile(root), 'utf8').trim();
  } catch {
    return '';
  }
}

export interface UpdateCheck {
  behind: number;
  needsBuild?: boolean;
  latest?: string;
}

export function checkForUpdate(): Promise<UpdateCheck | undefined> {
  return serialized(async () => {
    const root = repoRoot();
    try {
      await git(root, ['fetch', '--quiet', 'origin', 'main'], 15_000);
      const { stdout } = await git(root, ['rev-list', '--count', 'HEAD..origin/main'], 5_000);
      const behind = parseInt(stdout.trim(), 10) || 0;
      const { stdout: head } = await git(root, ['rev-parse', 'HEAD'], 5_000);
      const stamp = readStamp(root);
      // stamp exists but doesn't match HEAD ⇒ a previous update pulled code and then
      // failed to build — dist is stale even though git says up to date
      const needsBuild = stamp !== '' && stamp !== head.trim();
      if (behind === 0 && !needsBuild) return { behind: 0 };
      let latest: string | undefined;
      if (behind > 0) {
        const { stdout: subject } = await git(root, ['log', '-1', '--format=%s', 'origin/main'], 5_000);
        latest = subject.trim();
      }
      return { behind, needsBuild, latest };
    } catch {
      return undefined; // offline or not a git checkout — never block the UI on this
    }
  });
}

export interface UpdateResult {
  ok: boolean;
  updated: boolean;
  message: string;
}

export function runSelfUpdate(): Promise<UpdateResult> {
  return serialized(async () => {
    const root = repoRoot();
    try {
      const { stdout: dirty } = await git(root, ['status', '--porcelain'], 10_000);
      if (dirty.trim()) {
        return { ok: false, updated: false, message: `Local changes in ${root} — commit them first, then update.` };
      }
      await git(root, ['pull', '--ff-only'], 60_000);
      const { stdout: head } = await git(root, ['rev-parse', 'HEAD'], 5_000);
      if (readStamp(root) === head.trim()) {
        return { ok: true, updated: false, message: 'Already up to date.' };
      }
      await execa('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], {
        cwd: root,
        timeout: 300_000,
      });
      await execa('npm', ['run', 'build'], { cwd: root, timeout: 300_000 });
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.writeFileSync(stampFile(root), head.trim());
      return { ok: true, updated: true, message: '✔ Updated — quit and run houston again to load the new version.' };
    } catch (err: any) {
      return {
        ok: false,
        updated: false,
        message: `Update failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 120)}`,
      };
    }
  });
}
