import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildLiveSessions, buildProjects, sortSessions } from '../core/snapshot.js';
import { readTimeline } from '../core/historyReader.js';
import { readTailRecords } from '../core/transcriptReader.js';
import { buildRecentTurns } from '../core/transcriptIndex.js';
import { gitStatus } from '../core/gitOps.js';
import { repoRootFor } from '../core/projects.js';
import { cachedSummary, summarize, summarizeInFlight, takeLastSummarizeError } from '../core/summarizer.js';
import type { Session } from '../core/types.js';

function json(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function sessionView(s: Session) {
  return {
    sessionId: s.sessionId,
    pid: s.pid,
    name: s.name,
    title: s.intel?.title ?? s.name,
    status: s.status,
    endReason: s.endReason,
    cwd: s.cwd,
    model: s.intel?.model,
    contextTokens: s.intel?.contextTokens,
    contextWindow: s.contextWindow,
    contextPct: s.contextPct,
    turns: s.intel?.turns,
    lastPrompt: s.intel?.lastPrompt?.slice(0, 300),
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt ?? s.statusUpdatedAt,
    dangerFlag: s.danger ?? false,
    maybeWaiting: s.maybeWaiting ?? false,
    isHoustonChild: s.isHoustonChild ?? false,
    limit: s.intel?.limit
      ? {
          message: s.intel.limit.message,
          hitAt: s.intel.limit.hitAt,
          resetsAt: s.intel.limit.resetsAt,
        }
      : undefined,
  };
}

async function findSession(sessionId: string): Promise<Session | undefined> {
  const sessions = await buildLiveSessions();
  return (
    sessions.find((s) => s.sessionId === sessionId) ??
    sessions.find((s) => s.sessionId.startsWith(sessionId))
  );
}

const SUMMARIZE_WAIT_MS = 8000;

export function registerTools(server: McpServer): void {
  server.registerTool(
    'list_sessions',
    {
      description:
        'List Claude Code sessions running on this machine right now (and recently crashed ones with includeEnded). Shows status (busy/idle/limited/ended — limited means paused on a usage limit, with the reset time), title, project directory, context-window usage, and whether a session looks stuck waiting for the user.',
      inputSchema: {
        includeEnded: z.boolean().optional().describe('Also include ended/crashed sessions (default false)'),
        project: z.string().optional().describe('Filter: only sessions whose cwd contains this substring'),
      },
    },
    async ({ includeEnded, project }) => {
      try {
        let sessions = sortSessions(await buildLiveSessions());
        if (!includeEnded) sessions = sessions.filter((s) => s.status !== 'ended');
        if (project) sessions = sessions.filter((s) => s.cwd.includes(project));
        return json({ count: sessions.length, sessions: sessions.map(sessionView) });
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );

  server.registerTool(
    'session_detail',
    {
      description:
        'Full detail for one session: metadata, recent conversation turns, files it touched, token usage, and git status of its project.',
      inputSchema: {
        sessionId: z.string().describe('Session id (or unique prefix) from list_sessions'),
        tailTurns: z.number().int().min(1).max(50).optional().describe('How many recent turns to include (default 10)'),
      },
    },
    async ({ sessionId, tailTurns }) => {
      try {
        const session = await findSession(sessionId);
        if (!session) return json({ error: `No session matching "${sessionId}"` });
        let recentTurns: unknown[] = [];
        if (session.transcriptPath) {
          const tail = await readTailRecords(session.transcriptPath);
          recentTurns = buildRecentTurns(tail, tailTurns ?? 10);
        }
        const root = await repoRootFor(session.cwd);
        const git = await gitStatus(root);
        return json({
          ...sessionView(session),
          firstPrompt: session.intel?.firstPrompt?.slice(0, 1000),
          filesTouched: session.intel?.filesTouched ?? [],
          outputTokensTail: session.intel?.outputTokensTail,
          permissionMode: session.intel?.permissionMode,
          recentTurns,
          projectRoot: root,
          git,
        });
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );

  server.registerTool(
    'summarize_session',
    {
      description:
        'AI summary of what a session has DONE, what REMAINS, its current focus, and blockers. Cached per transcript version; a cache miss starts generation in the background — call again in ~15s if you get status "generating".',
      inputSchema: {
        sessionId: z.string().describe('Session id (or unique prefix) from list_sessions'),
        refresh: z.boolean().optional().describe('Force regeneration even if a cached summary exists'),
      },
    },
    async ({ sessionId, refresh }) => {
      try {
        const session = await findSession(sessionId);
        if (!session) return json({ error: `No session matching "${sessionId}"` });
        if (!session.transcriptPath) return json({ error: 'No transcript found for this session yet.' });
        if (!refresh) {
          const hit = cachedSummary(session.sessionId, session.transcriptPath);
          if (hit) return json({ ...hit.summary, cached: true, generatedAt: hit.generatedAt });
        }
        const lastError = takeLastSummarizeError(session.sessionId);
        if (lastError && !summarizeInFlight(session.sessionId)) {
          return json({ status: 'error', error: `Previous summarize attempt failed: ${lastError}` });
        }
        const job = summarize(
          {
            sessionId: session.sessionId,
            cwd: session.cwd,
            transcriptPath: session.transcriptPath,
            title: session.intel?.title,
          },
          { refresh },
        );
        // Wait briefly; if haiku finishes fast return the real thing, else hand back a
        // "generating" marker instead of risking the caller's MCP tool timeout.
        const result = await Promise.race([
          job.then((r) => ({ done: true as const, r })),
          new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), SUMMARIZE_WAIT_MS)),
        ]);
        if (result.done) return json({ ...result.r.summary, cached: false, generatedAt: result.r.generatedAt });
        job.catch(() => {}); // keep generating in background; surface errors on next call
        return json({ status: 'generating', note: 'Summary is being generated — call summarize_session again in ~15 seconds.' });
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );

  server.registerTool(
    'stats',
    {
      description:
        'Fleet statistics: how many Claude sessions are running/idle/ended, per-session context-window usage and model, and whether any look stuck.',
      inputSchema: {},
    },
    async () => {
      try {
        const sessions = sortSessions(await buildLiveSessions());
        const busy = sessions.filter((s) => s.status === 'busy');
        const limited = sessions.filter((s) => s.status === 'limited');
        const idle = sessions.filter((s) => s.status === 'idle');
        const ended = sessions.filter((s) => s.status === 'ended');
        return json({
          running: busy.length,
          atUsageLimit: limited.length,
          idle: idle.length,
          ended: ended.length,
          possiblyWaitingOnUser: sessions.filter((s) => s.maybeWaiting).map((s) => s.sessionId),
          summarizing: sessions.filter((s) => summarizeInFlight(s.sessionId)).map((s) => s.sessionId),
          perSession: sessions.map((s) => ({
            sessionId: s.sessionId,
            name: s.name,
            title: s.intel?.title,
            status: s.status,
            model: s.intel?.model,
            contextPct: s.contextPct,
            contextWindow: s.contextWindow,
            turns: s.intel?.turns,
          })),
        });
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );

  server.registerTool(
    'recent_activity',
    {
      description: 'Recent prompts the user typed across ALL sessions (global activity timeline), newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 20)'),
        project: z.string().optional().describe('Filter: only prompts from projects whose path contains this substring'),
      },
    },
    async ({ limit, project }) => {
      try {
        let timeline = await readTimeline(limit ?? 20);
        if (project) timeline = timeline.filter((t) => t.project.includes(project));
        return json(timeline);
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );

  server.registerTool(
    'project_git_status',
    {
      description:
        'Read-only git status for a project directory: branch, dirty file count, +/- lines, ahead/behind, last commit. Git WRITES (commit/push) are intentionally only available in the houston TUI.',
      inputSchema: {
        project: z.string().describe('Absolute path of the project (any directory inside the repo works)'),
      },
    },
    async ({ project }) => {
      try {
        const root = await repoRootFor(project);
        const git = await gitStatus(root);
        const projects = await buildProjects(sortSessions(await buildLiveSessions()));
        const info = projects.find((p) => p.root === root);
        return json({ root, ...git, hasGraphify: info?.hasGraphify ?? false, activeSessions: info?.sessionIds ?? [] });
      } catch (err) {
        return json({ error: String(err) });
      }
    },
  );
}
