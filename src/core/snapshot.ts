import fs from 'node:fs';
import { readRegistry, isAlive, procStartMatches, isHoustonChild } from './sessionRegistry.js';
import { getIntel } from './transcriptIndex.js';
import { windowFor, contextPct } from './contextMeter.js';
import { transcriptPathFor, repoRootFor, hasGraphify } from './projects.js';
import { gitStatus } from './gitOps.js';
import { listRuns } from './launcher.js';
import { readTailRecords } from './transcriptReader.js';
import type { GitStatusInfo, ProjectInfo, Session } from './types.js';

const HIDE_ENDED_AFTER_MS = 24 * 3600_000;

// A headless run's stream-json log ends with a `result` record — more reliable than PID
// liveness (which can be fooled by PID reuse) for deciding a run is over.
async function runFinished(logFile: string): Promise<boolean> {
  try {
    const tail = await readTailRecords(logFile, 8192);
    return tail.some((r) => r.type === 'result' || r.type === 'houston-spawn-error');
  } catch {
    return false;
  }
}

// One-shot session view built purely from disk — used by both the TUI store (which adds
// tombstones and alerts on top) and the MCP server (fresh read per tool call).
export async function buildLiveSessions(): Promise<Session[]> {
  const bySessionId = new Map<string, Session>();
  for (const entry of readRegistry()) {
    if (isHoustonChild(entry)) continue;
    const alive = isAlive(entry.pid) && (await procStartMatches(entry.pid, entry));
    const session: Session = {
      sessionId: entry.sessionId,
      pid: entry.pid,
      name: entry.name,
      cwd: entry.cwd ?? '',
      status: alive ? (entry.status === 'busy' ? 'busy' : 'idle') : 'ended',
      rawStatus: entry.status,
      kind: entry.kind,
      startedAt: entry.startedAt,
      statusUpdatedAt: entry.statusUpdatedAt ?? entry.updatedAt,
    };
    if (!alive) session.endReason = 'crashed'; // graceful exits delete the registry file
    await attachIntel(session);
    // A hit limit trumps the registry status: the registry can be stuck on "busy" from
    // the turn that died at the limit. Once the reset time passes, the session is just
    // waiting for the user (or a schedule) — show it idle, not "working".
    if (alive && session.intel?.limit) {
      const { resetsAt } = session.intel.limit;
      session.status = resetsAt !== undefined && resetsAt <= Date.now() ? 'idle' : 'limited';
    }
    // a crashed session's stale registry file can coexist with its resumed successor —
    // one card per sessionId, live entry wins
    const existing = bySessionId.get(session.sessionId);
    if (!existing || (existing.status === 'ended' && session.status !== 'ended')) {
      bySessionId.set(session.sessionId, session);
    }
  }
  const sessions = [...bySessionId.values()];
  for (const run of listRuns()) {
    const finished = await runFinished(run.logFile);
    const alive =
      !finished && run.pid !== undefined && isAlive(run.pid) && (await procStartMatches(run.pid, run));
    if (!alive && Date.now() - run.startedAt > HIDE_ENDED_AFTER_MS) continue;
    let logMtime: number | undefined;
    try {
      logMtime = fs.statSync(run.logFile).mtimeMs;
    } catch {
      // log file gone — startedAt is the only signal left
    }
    sessions.push({
      sessionId: `run:${run.id}`,
      pid: run.pid,
      name: run.kind === 'follow-up' ? 'follow-up' : 'headless run',
      cwd: run.dir,
      status: alive ? 'busy' : 'ended',
      startedAt: run.startedAt,
      lastActivityAt: logMtime ?? run.startedAt,
      isHoustonChild: true,
      intel: {
        title: `${run.kind}: ${run.prompt.slice(0, 60)}`,
        lastPrompt: run.prompt,
        turns: 0,
        filesTouched: [],
        contextTokens: 0,
      },
    });
  }
  return sessions;
}

export async function attachIntel(session: Session): Promise<void> {
  if (!session.cwd) return;
  session.transcriptPath = transcriptPathFor(session.sessionId, session.cwd);
  if (!session.transcriptPath) {
    session.lastActivityAt = session.statusUpdatedAt;
    return;
  }
  try {
    session.transcriptMtimeMs = fs.statSync(session.transcriptPath).mtimeMs;
  } catch {
    // transcript vanished between path resolution and stat
  }
  session.lastActivityAt =
    Math.max(session.statusUpdatedAt ?? 0, session.transcriptMtimeMs ?? 0) || undefined;
  try {
    const intel = await getIntel(session.transcriptPath);
    if (intel) {
      session.intel = intel;
      session.contextWindow = windowFor(intel.model, intel.contextTokens);
      session.contextPct = contextPct(intel.contextTokens, session.contextWindow);
      session.danger = intel.permissionMode === 'bypassPermissions';
    }
  } catch {
    // transcript unreadable — registry data alone is enough to render a card
  }
}

const gitCache = new Map<string, { at: number; info: GitStatusInfo }>();
const GIT_TTL_MS = 3000;

export async function buildProjects(sessions: Session[]): Promise<ProjectInfo[]> {
  const byRoot = new Map<string, ProjectInfo>();
  // ended sessions keep their project visible — committing/pushing FINISHED work is the
  // whole point of the git buttons
  for (const session of sessions) {
    if (!session.cwd) continue;
    const root = await repoRootFor(session.cwd);
    let project = byRoot.get(root);
    if (!project) {
      project = { root, cwds: [], isRepo: false, hasGraphify: hasGraphify(root), sessionIds: [] };
      byRoot.set(root, project);
    }
    if (!project.cwds.includes(session.cwd)) project.cwds.push(session.cwd);
    project.sessionIds.push(session.sessionId);
  }
  for (const project of byRoot.values()) {
    const hit = gitCache.get(project.root);
    if (hit && Date.now() - hit.at < GIT_TTL_MS) {
      project.git = hit.info;
    } else {
      project.git = await gitStatus(project.root);
      gitCache.set(project.root, { at: Date.now(), info: project.git });
    }
    project.isRepo = project.git.isRepo;
  }
  return [...byRoot.values()];
}

export function sortSessions(sessions: Session[]): Session[] {
  const rank = { busy: 0, limited: 1, idle: 2, ended: 3 } as const;
  return [...sessions].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return (
      (b.lastActivityAt ?? b.statusUpdatedAt ?? b.startedAt ?? 0) -
      (a.lastActivityAt ?? a.statusUpdatedAt ?? a.startedAt ?? 0)
    );
  });
}
