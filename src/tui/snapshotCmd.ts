import { buildLiveSessions, buildProjects, sortSessions } from '../core/snapshot.js';
import { readTimeline } from '../core/historyReader.js';
import { ensureDirs } from '../core/paths.js';
import { fmtTokens } from './theme.js';

// One-shot text dump for non-TTY contexts (scripts, `houston --snapshot`, or when someone
// asks Claude itself to run houston inside its Bash tool).
export async function printSnapshot(): Promise<void> {
  ensureDirs();
  const sessions = sortSessions(await buildLiveSessions());
  const projects = await buildProjects(sessions);
  const timeline = await readTimeline(8);

  console.log(`houston snapshot — ${new Date().toLocaleString()}\n`);
  if (sessions.length === 0) {
    console.log('No Claude sessions found. Open Terminal and run `claude`.');
  }
  for (const s of sessions) {
    const title = s.intel?.title ?? s.name ?? s.sessionId.slice(0, 8);
    const ctx =
      s.intel && s.contextWindow
        ? ` ctx ${s.contextPct}% (${fmtTokens(s.intel.contextTokens)}/${fmtTokens(s.contextWindow)})`
        : '';
    const flags = [
      s.danger ? 'DANGER:bypassPermissions' : '',
      s.maybeWaiting ? 'possibly-waiting-on-you' : '',
      s.status === 'limited' && s.intel?.limit?.resetsAt
        ? `resets ${new Date(s.intel.limit.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : '',
      s.endReason ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`[${s.status.toUpperCase().padEnd(5)}] ${title}`);
    console.log(`        ${s.cwd}${ctx}${flags ? `  ${flags}` : ''}`);
    if (s.intel?.lastPrompt) console.log(`        last: ${s.intel.lastPrompt.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  console.log('\nprojects:');
  for (const p of projects) {
    const git = p.git?.isRepo
      ? `${p.git.branch} · ${p.git.dirtyFiles} dirty +${p.git.insertions}/-${p.git.deletions}${p.git.ahead ? ` · ${p.git.ahead} to push` : ''}`
      : 'not a git repo';
    console.log(`  ${p.root} — ${git}${p.hasGraphify ? ' · graphify ✓' : ''}`);
  }
  if (timeline.length) {
    console.log('\nrecent prompts:');
    for (const t of timeline) {
      const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '';
      console.log(`  ${time}  ${t.prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
}
