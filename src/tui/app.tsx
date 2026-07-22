import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { SessionStore } from '../core/store.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { HeaderBar } from './components/headerBar.js';
import { CommandBar, matchCommand, parseCardNumber, type WordCommand } from './components/commandBar.js';
import { HelpOverlay } from './components/helpOverlay.js';
import { Dashboard, SIDE_WIDTH } from './screens/dashboard.js';
import { SessionDetail } from './screens/sessionDetail.js';
import { NewSession } from './screens/newSession.js';
import { CommitFlow } from './screens/commitFlow.js';
import { push as gitPush, saveVersion } from '../core/gitOps.js';
import { summarize } from '../core/summarizer.js';
import { jumpToTerminal, interruptSession, typeIntoTerminal } from '../core/launcher.js';
import { dismissSession } from '../core/dismissals.js';
import { addSchedule, cancelSchedule, parseTimeSpec, type FireResult } from '../core/scheduler.js';
import { checkForUpdate, runSelfUpdate, type UpdateCheck } from '../core/selfUpdate.js';
import { CARD_WIDTH, fmtClock } from './theme.js';
import type { Session } from '../core/types.js';

type Screen = 'dashboard' | 'detail' | 'new' | 'commit';

// long enough for `schedule 7:30 <a short custom prompt>`
const MAX_CMD_LEN = 80;

export function App() {
  const { exit } = useApp();
  const store = useMemo(() => new SessionStore(), []);
  const snapshot = useStore(store);
  const size = useTerminalSize();
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [focusIdx, setFocusIdx] = useState(0);
  // detail and commit targets are tracked by IDENTITY, never by grid position — the
  // session list re-sorts on every snapshot, so indices silently retarget
  const [detailId, setDetailId] = useState<string | undefined>();
  const [commitRoot, setCommitRoot] = useState<string | undefined>();
  const [showHelp, setShowHelp] = useState(false);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [toast, setToast] = useState<string | undefined>();
  const [cmdText, setCmdText] = useState('');
  const [pendingStop, setPendingStop] = useState<Session | undefined>();
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | undefined>();
  const [updating, setUpdating] = useState(false);

  const sessions = snapshot?.sessions ?? [];
  const clampedIdx = Math.min(focusIdx, Math.max(0, sessions.length - 1));
  const focused: Session | undefined = sessions[clampedIdx];
  const focusedProject = snapshot?.projects.find((p) => focused && p.sessionIds.includes(focused.sessionId));

  const detailSession = detailId ? sessions.find((s) => s.sessionId === detailId) : undefined;
  const detailProject = snapshot?.projects.find((p) => detailSession && p.sessionIds.includes(detailSession.sessionId));
  const commitProject = commitRoot ? snapshot?.projects.find((p) => p.root === commitRoot) : undefined;

  useEffect(() => {
    if (screen === 'detail' && !detailSession) setScreen('dashboard');
    if (screen === 'commit' && !commitProject) setScreen('dashboard');
  }, [screen, detailSession, commitProject]);

  // one silent check at startup; the header shows "⬆ update available" if behind
  useEffect(() => {
    checkForUpdate().then(setUpdateInfo).catch(() => {});
  }, []);

  const showSide = size.columns >= CARD_WIDTH + SIDE_WIDTH + 4;
  const cardArea = showSide ? size.columns - SIDE_WIDTH : size.columns;
  const cardsPerRow = Math.max(1, Math.floor(cardArea / CARD_WIDTH));

  const say = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((current) => (current === msg ? undefined : current)), 8000);
  }, []);

  const label = (s: Session) => s.intel?.title ?? s.name ?? s.sessionId.slice(0, 8);

  // the store fires due auto-continue schedules on its own clock — surface each outcome
  useEffect(() => {
    const onFired = (result: FireResult) => {
      const title = result.entry.label ?? result.entry.sessionId.slice(0, 8);
      say(result.ok ? `⏱ continued "${title}" — ${result.how}` : `⏱ schedule for "${title}": ${result.how}`);
    };
    store.on('schedule-fired', onFired);
    return () => {
      store.off('schedule-fired', onFired);
    };
  }, [store, say]);

  const doSummarize = useCallback(
    (session: Session, refresh = false) => {
      if (session.agent === 'codex') return say('Summaries read Claude transcripts — not supported for codex sessions yet.');
      say('Summarizing with Haiku…');
      summarize(
        {
          sessionId: session.sessionId,
          cwd: session.cwd,
          transcriptPath: session.transcriptPath,
          title: session.intel?.title,
        },
        { refresh },
      )
        .then(() => {
          say('Summary ready — type details to read it.');
          store.scheduleRefresh();
        })
        .catch((err) => say(`Summary failed: ${String(err?.message ?? err).slice(0, 100)}`));
    },
    [say, store],
  );

  const doPush = useCallback(async () => {
    if (!focusedProject) return say('No project for this session.');
    if (!focusedProject.isRepo) return say('Not a git repo yet — type commit to set one up.');
    say('Pushing…');
    try {
      const res = await gitPush(focusedProject.root);
      say(res.ok ? `✔ ${res.message}` : `${res.message}${res.suggestion ? ` → ${res.suggestion}` : ''}`);
    } catch (err: any) {
      say(`Push failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }, [focusedProject, say]);

  const doSaveVersion = useCallback(async () => {
    if (!focusedProject) return say('No project for this session.');
    if (!focusedProject.isRepo) return say('Not a git repo yet — type commit to set one up.');
    try {
      const tag = await saveVersion(focusedProject.root);
      say(`✔ saved version ${tag} — type push to send it to GitHub.`);
    } catch (err: any) {
      say(`Save failed: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }, [focusedProject, say]);

  const doGraph = useCallback(
    (force: boolean) => {
      if (!focusedProject) return say('No project for this session.');
      if (!focusedProject.hasGraphify) return say('No graphify-out/ in this project — run /graphify there once first.');
      say(force ? 'Force-updating knowledge graph…' : 'Updating knowledge graph…');
      void store.graphify.update(focusedProject.root, force).then(() => {
        store.graphify.retry(focusedProject.root);
        const state = store.graphify.stateFor(focusedProject.root);
        say(state?.lastError ?? '✔ knowledge graph updated (zero tokens).');
      });
    },
    [focusedProject, say, store],
  );

  const doSelfUpdate = useCallback(async () => {
    if (updating) return say('Update already running…');
    setUpdating(true);
    try {
      const result = await runSelfUpdate();
      say(result.message);
      if (result.ok) setUpdateInfo({ behind: 0 });
    } finally {
      setUpdating(false);
    }
  }, [say, updating]);

  const openDetail = useCallback(() => {
    if (!focused) return;
    store.dismissAlert(focused.sessionId);
    setDetailId(focused.sessionId);
    setScreen('detail');
  }, [focused, store]);

  const quit = useCallback(() => {
    // quitting mid-update would SIGTERM npm install and strand a half-built install
    if (updating) return say('Update in progress — let it finish before quitting.');
    store.stop();
    exit();
  }, [store, exit, updating, say]);

  // resolve an optional "2"/"two" card-number token to a session; undefined token → focused
  const cardFor = useCallback(
    (token?: string): { session?: Session; error?: string } => {
      const n = parseCardNumber(token);
      if (token && n === undefined) return { error: `"${token}" is not a card number — cards are numbered 1 to ${sessions.length}.` };
      if (n === undefined) return { session: focused };
      if (n < 1 || n > sessions.length) return { error: `There is no session ${n} — cards are numbered 1 to ${sessions.length}.` };
      return { session: sessions[n - 1] };
    },
    [focused, sessions],
  );

  const doSchedule = useCallback(
    (args?: string) => {
      const [timeSpec, ...rest] = (args ?? '').split(/\s+/).filter(Boolean);
      // `schedule 1900 2` (or `schedule 1900 two`) → second card; no number → focused card
      let target = focused;
      if (rest.length > 0 && parseCardNumber(rest[0]) !== undefined) {
        const { session, error } = cardFor(rest[0]);
        if (error) return say(error);
        target = session;
        rest.shift();
      }
      if (!target) return say('No session focused.');
      if (target.sessionId.startsWith('run:')) return say('Background runs cannot be scheduled — only real sessions.');
      const prompt = rest.join(' ') || 'continue';
      let at: number | undefined;
      if (timeSpec) {
        at = parseTimeSpec(timeSpec);
        if (at === undefined) return say(`Couldn't read "${timeSpec}" as a time — try 1900, 730 or 7:30am.`);
      } else if (target.intel?.limit?.resetsAt) {
        at = target.intel.limit.resetsAt + 2 * 60_000; // small buffer past the reset
      } else {
        return say('Usage: schedule 1900 [session#] [prompt] — or just schedule on a limit-hit session to use its reset time.');
      }
      addSchedule({ sessionId: target.sessionId, agent: target.agent, cwd: target.cwd, at, prompt, label: label(target) });
      store.scheduleRefresh();
      say(`⏱ will send "${prompt}" to "${label(target)}" at ${fmtClock(at)} (houston must be running then).`);
    },
    [focused, cardFor, say, store],
  );

  const doComplete = useCallback(
    (args?: string) => {
      const { session, error } = cardFor(args?.trim() || undefined);
      if (error) return say(error);
      if (!session) return say('No session focused.');
      dismissSession(session.sessionId);
      store.scheduleRefresh();
      say(`✓ completed "${label(session)}" — hidden from the board (reappears if it sees new activity).`);
    },
    [cardFor, say, store],
  );

  // types "update graphify" into that session's Terminal tab — the Claude there runs it
  const doGraphifyRemote = useCallback(
    (args?: string) => {
      const { session, error } = cardFor(args?.trim() || undefined);
      if (error) return say(error);
      if (!session) return say('No session focused.');
      if (!session.pid || session.status === 'ended') return say('That session is not running.');
      say(`Typing "update graphify" into "${label(session)}"…`);
      void typeIntoTerminal(session.pid, 'update graphify').then((ok) => {
        say(ok ? `✔ sent "update graphify" to "${label(session)}".` : "Couldn't find that session's Terminal tab (or Accessibility permission is missing).");
      });
    },
    [cardFor, say],
  );

  const commands: WordCommand[] = useMemo(
    () => [
      { name: 'commit', aliases: ['c'], desc: 'stage changes, AI writes the message, you approve', run: () => {
        if (!focusedProject) return say('No project for this session.');
        setCommitRoot(focusedProject.root);
        setScreen('commit');
      } },
      { name: 'push', aliases: ['p'], desc: 'push this project to GitHub', run: () => void doPush() },
      { name: 'version', aliases: ['v', 'save'], desc: 'commit if needed + tag a checkpoint', run: () => void doSaveVersion() },
      { name: 'summarize', aliases: ['s'], desc: 'AI summary: done / remaining / focus', run: () => (focused ? doSummarize(focused) : say('No session focused.')) },
      { name: 'details', aliases: ['d', 'open'], desc: 'open the focused session', run: openDetail },
      { name: 'new', aliases: ['n'], desc: 'start a new Claude session', run: () => setScreen('new') },
      { name: 'jump', aliases: ['j'], desc: 'bring that Terminal tab to the front', run: () => {
        if (!focused?.pid) return say('No running session focused.');
        void jumpToTerminal(focused.pid).then((ok) => {
          if (!ok) say("Couldn't find that session's Terminal tab.");
        });
      } },
      { name: 'stop', aliases: ['x', 'interrupt'], desc: "interrupt the focused session's current turn", run: () => {
        if (!focused?.pid || focused.status === 'ended') return say('Focused session is not running.');
        setPendingStop(focused);
      } },
      { name: 'schedule', aliases: ['at'], takesArgs: true, desc: 'auto-continue later: schedule 1900 [session#] [prompt]', run: (args) => doSchedule(args) },
      { name: 'unschedule', aliases: ['cancel'], takesArgs: true, desc: 'cancel an auto-continue: unschedule [card#]', run: (args) => {
        const { session, error } = cardFor(args?.trim() || undefined);
        if (error) return say(error);
        if (!session) return say('No session focused.');
        say(cancelSchedule(session.sessionId) ? `Cancelled auto-continue for "${label(session)}".` : 'Nothing scheduled for this session.');
        store.scheduleRefresh();
      } },
      { name: 'complete', aliases: ['done', 'tick'], takesArgs: true, desc: 'mark a card done and hide it: complete [card#]', run: (args) => doComplete(args) },
      // graph before graphify: "gr" ↵ must recommend the safe zero-token local update,
      // not the command that types into a live session
      { name: 'graph', aliases: ['g'], desc: 'update the knowledge graph (zero tokens)', run: () => doGraph(false) },
      { name: 'graph force', desc: 'force graph update past the shrink guard', run: () => doGraph(true) },
      { name: 'graphify', takesArgs: true, desc: 'tell that Claude session to update its graph: graphify [card#]', run: (args) => doGraphifyRemote(args) },
      { name: 'update', aliases: ['u', 'upgrade'], desc: 'update houston itself to the latest version', run: () => void doSelfUpdate() },
      { name: 'refresh', aliases: ['r'], desc: 'refresh the dashboard now', run: () => store.scheduleRefresh() },
      { name: 'help', aliases: ['?'], desc: 'show every command', run: () => setShowHelp(true) },
      { name: 'quit', aliases: ['q', 'exit'], desc: 'quit houston (your sessions keep running)', run: quit },
    ],
    [focused, focusedProject, cardFor, doPush, doSaveVersion, doSummarize, doGraph, doSchedule, doComplete, doGraphifyRemote, doSelfUpdate, openDetail, quit, say, store],
  );

  useInput(
    (input, key) => {
      if (showHelp) return setShowHelp(false);

      // confirm-first: "any other key cancels" must include arrows
      if (pendingStop) {
        if (input.toLowerCase() === 'y' && pendingStop.pid) {
          say(
            interruptSession(pendingStop.pid)
              ? `Sent interrupt to "${label(pendingStop)}" (like pressing Esc there).`
              : 'Could not signal that session.',
          );
        }
        setPendingStop(undefined);
        return;
      }

      // arrows/tab always navigate, even mid-typing — functional updates so key-repeat
      // events arriving in one stdin chunk compose instead of overwriting each other
      const last = Math.max(0, sessions.length - 1);
      if (key.leftArrow || (key.shift && key.tab)) return setFocusIdx((i) => Math.max(0, Math.min(i, last) - 1));
      if (key.rightArrow || key.tab) return setFocusIdx((i) => Math.min(last, Math.min(i, last) + 1));
      if (key.upArrow) return setFocusIdx((i) => Math.max(0, Math.min(i, last) - cardsPerRow));
      if (key.downArrow) return setFocusIdx((i) => Math.min(last, Math.min(i, last) + cardsPerRow));
      if (key.pageUp) {
        const maxOffset = Math.max(0, (snapshot?.timeline.length ?? 0) - 3);
        return setTimelineOffset((o) => Math.min(maxOffset, o + 3));
      }
      if (key.pageDown) return setTimelineOffset((o) => Math.max(0, o - 3));

      if (key.escape) return setCmdText('');
      if (key.backspace || key.delete) return setCmdText((t) => t.slice(0, -1));
      if (key.return) {
        const typed = cmdText.trim();
        if (!typed) return openDetail(); // enter on an empty bar = open the focused card
        // auto-recommend: enter runs the best match even on a partial word ("co" → commit);
        // the ghost completion in the bar already showed what enter would do
        const { best, args } = matchCommand(commands, typed);
        setCmdText('');
        if (best) best.run(args);
        else say(`Unknown command "${typed}" — type help to see them all.`);
        return;
      }
      if (input === '?' && !cmdText) return setShowHelp(true);
      if (input && !key.ctrl && !key.meta) {
        // pasted text can carry newlines/control bytes that would garble the bar
        const clean = input.replace(/[\u0000-\u001f\u007f]/g, '');
        if (clean) setCmdText((t) => (t + clean).slice(0, MAX_CMD_LEN));
      }
    },
    { isActive: screen === 'dashboard' },
  );

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text color="cyan">HOUSTON</Text>
        <Text dimColor> scanning your Claude sessions…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={size.columns} minHeight={size.rows}>
      <HeaderBar snapshot={snapshot} updateAvailable={(updateInfo?.behind ?? 0) > 0} />
      {showHelp ? (
        <HelpOverlay />
      ) : screen === 'dashboard' ? (
        <Dashboard snapshot={snapshot} focused={focused} timelineOffset={timelineOffset} size={size} />
      ) : screen === 'detail' && detailSession ? (
        <SessionDetail
          key={detailSession.sessionId}
          session={detailSession}
          project={detailProject}
          onBack={() => {
            setDetailId(undefined);
            setScreen('dashboard');
          }}
          onSummarize={doSummarize}
          say={say}
        />
      ) : screen === 'new' ? (
        <NewSession
          projects={snapshot.projects}
          onDone={(msg) => {
            setScreen('dashboard');
            if (msg) say(msg);
            store.scheduleRefresh();
          }}
        />
      ) : screen === 'commit' && commitProject ? (
        <CommitFlow
          key={commitProject.root}
          project={commitProject}
          projectBusy={sessions.some(
            (s) => commitProject.sessionIds.includes(s.sessionId) && s.status === 'busy',
          )}
          onDone={(msg) => {
            setCommitRoot(undefined);
            setScreen('dashboard');
            if (msg) say(msg);
            store.scheduleRefresh();
          }}
        />
      ) : null}
      {toast && screen !== 'dashboard' && (
        <Box paddingX={1}>
          <Text color="cyan">{toast}</Text>
        </Box>
      )}
      {screen === 'dashboard' && !showHelp && (
        <CommandBar
          text={cmdText}
          commands={commands}
          toast={toast}
          confirm={
            updating
              ? '⏳ Updating houston (pull + install + build) — this can take a minute; quitting is blocked until it finishes.'
              : pendingStop
                ? `Interrupt "${label(pendingStop)}"? press y to confirm, any other key cancels`
                : undefined
          }
        />
      )}
    </Box>
  );
}
