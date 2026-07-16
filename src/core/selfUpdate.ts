import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

// compiled location is <root>/dist/core/selfUpdate.js — the install dir IS a git clone,
// so updating = pull + rebuild, same as re-running the curl installer.
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface UpdateCheck {
  behind: number;
  latest?: string;
}

export async function checkForUpdate(): Promise<UpdateCheck | undefined> {
  const root = repoRoot();
  try {
    await execa('git', ['-C', root, 'fetch', '--quiet', 'origin', 'main'], { timeout: 15_000 });
    const { stdout } = await execa('git', ['-C', root, 'rev-list', '--count', 'HEAD..origin/main'], {
      timeout: 5_000,
    });
    const behind = parseInt(stdout.trim(), 10) || 0;
    if (behind === 0) return { behind: 0 };
    const { stdout: latest } = await execa('git', ['-C', root, 'log', '-1', '--format=%s', 'origin/main'], {
      timeout: 5_000,
    });
    return { behind, latest: latest.trim() };
  } catch {
    return undefined; // offline or not a git checkout — never block the UI on this
  }
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

export async function runSelfUpdate(): Promise<UpdateResult> {
  const root = repoRoot();
  try {
    const { stdout: dirty } = await execa('git', ['-C', root, 'status', '--porcelain'], { timeout: 10_000 });
    if (dirty.trim()) {
      return { ok: false, message: `Local changes in ${root} — commit them first, then update.` };
    }
    const { stdout: before } = await execa('git', ['-C', root, 'rev-parse', 'HEAD']);
    await execa('git', ['-C', root, 'pull', '--ff-only'], { timeout: 60_000 });
    const { stdout: after } = await execa('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (before.trim() === after.trim()) return { ok: true, message: 'Already up to date.' };
    await execa('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], {
      cwd: root,
      timeout: 300_000,
    });
    await execa('npm', ['run', 'build'], { cwd: root, timeout: 300_000 });
    return { ok: true, message: '✔ Updated — quit and run houston again to load the new version.' };
  } catch (err: any) {
    return {
      ok: false,
      message: `Update failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 120)}`,
    };
  }
}
