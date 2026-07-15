import fs from 'node:fs';
import path from 'node:path';
import { execa, type ResultPromise } from 'execa';

export interface GraphifyState {
  root: string;
  watching: boolean;
  needsDocsUpdate: boolean;
  lastError?: string;
  updatedAt?: number;
}

const MAX_RESTARTS = 3;

function needsUpdateFlag(root: string): boolean {
  const out = path.join(root, 'graphify-out');
  return fs.existsSync(path.join(out, 'needs_update')) || fs.existsSync(path.join(out, '.needs_update'));
}

// Keeps a project's knowledge graph fresh at ZERO token cost: `graphify update` and
// `graphify watch` are deterministic AST extraction — no LLM for code changes. Docs and
// image changes DO need an LLM, so we only badge those (never auto-spend).
export class GraphifyBridge {
  private children = new Map<string, ResultPromise>();
  private states = new Map<string, GraphifyState>();
  private restarts = new Map<string, number>();
  private stopped = false;

  detect(root: string): boolean {
    return fs.existsSync(path.join(root, 'graphify-out', 'graph.json'));
  }

  stateFor(root: string): GraphifyState | undefined {
    const state = this.states.get(root);
    if (state) state.needsDocsUpdate = needsUpdateFlag(root);
    return state;
  }

  allStates(): GraphifyState[] {
    return [...this.states.keys()].map((root) => this.stateFor(root)!);
  }

  async start(root: string): Promise<void> {
    if (this.states.has(root) || this.stopped) return;
    const state: GraphifyState = { root, watching: false, needsDocsUpdate: needsUpdateFlag(root) };
    this.states.set(root, state);
    // One-shot incremental update strictly BEFORE the watcher spawns (never both at once).
    await this.update(root, false);
    this.spawnWatch(root, state);
  }

  // force=true is only ever user-initiated: it overrides graphify's shrink-guard, which
  // exists to stop a bad extraction from clobbering a good graph.
  async update(root: string, force: boolean): Promise<void> {
    const state = this.states.get(root);
    try {
      const args = ['update', root];
      if (force) args.push('--force');
      await execa('graphify', args, { cwd: root, timeout: 180_000, env: { ...process.env, HOUSTON_CHILD: '1' } });
      if (state) {
        state.updatedAt = Date.now();
        state.lastError = undefined;
      }
    } catch (err: any) {
      const msg = String(err?.stderr ?? err?.message ?? err);
      if (state) {
        state.lastError = /force|shrink|fewer/i.test(msg)
          ? 'graph shrank — press G to force-update'
          : msg.split('\n').find((l: string) => l.trim())?.slice(0, 120) ?? 'graphify update failed';
      }
    }
  }

  private spawnWatch(root: string, state: GraphifyState): void {
    if (this.stopped) return;
    const child = execa('graphify', ['watch', root], {
      cwd: root,
      env: { ...process.env, HOUSTON_CHILD: '1' },
    });
    this.children.set(root, child);
    state.watching = true;
    child.then(
      () => this.onWatchExit(root, state),
      () => this.onWatchExit(root, state),
    );
  }

  private onWatchExit(root: string, state: GraphifyState): void {
    state.watching = false;
    this.children.delete(root);
    if (this.stopped) return;
    const count = (this.restarts.get(root) ?? 0) + 1;
    this.restarts.set(root, count);
    if (count <= MAX_RESTARTS) {
      setTimeout(() => this.spawnWatch(root, state), count * 2000).unref();
    } else {
      state.lastError = 'graphify watch keeps exiting — press G to retry';
    }
  }

  retry(root: string): void {
    this.restarts.set(root, 0);
    const state = this.states.get(root);
    if (state && !state.watching) this.spawnWatch(root, state);
  }

  stopAll(): void {
    this.stopped = true;
    for (const child of this.children.values()) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    this.children.clear();
  }
}
