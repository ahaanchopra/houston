import fs from 'node:fs';
import { readRegistry, isAlive, procStartMatches, isHoustonChild } from './sessionRegistry.js';
import { getIntel } from './transcriptIndex.js';
import { windowFor, contextPct } from './contextMeter.js';
import { transcriptPathFor, repoRootFor, hasGraphify } from './projects.js';
import { gitStatus } from './gitOps.js';
import { listRuns } from './launcher.js';
import type { GitStatusInfo, ProjectInfo, Session } from './types.js';

const HIDE_ENDED_AFTER_MS = 24 * 3600_000;

// One-shot session view built purely from disk — used by both the TUI store (which adds
// tombstones and alerts on top) and the MCP server (fresh read per tool call).
export async function buildLiveSessions(): Promise<Session[]> {
  const sessions: Session[] = [];
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
    sessions.push(session);
  }
  for (const run of listRuns()) {
    const alive = run.pid ? isAlive(run.pid) : false;
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
  for (const session of sessions) {
    if (!session.cwd || session.status === 'ended') continue;
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
  const rank = { busy: 0, idle: 1, ended: 2 } as const;
  return [...sessions].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return (
      (b.lastActivityAt ?? b.statusUpdatedAt ?? b.startedAt ?? 0) -
      (a.lastActivityAt ?? a.statusUpdatedAt ?? a.startedAt ?? 0)
    );
  });
}
