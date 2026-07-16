import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { SessionStore } from '../core/store.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { HeaderBar } from './components/headerBar.js';
import { CommandBar, matchCommand, type WordCommand } from './components/commandBar.js';
import { HelpOverlay } from './components/helpOverlay.js';
import { Dashboard, SIDE_WIDTH } from './screens/dashboard.js';
import { SessionDetail } from './screens/sessionDetail.js';
import { NewSession } from './screens/newSession.js';
import { CommitFlow } from './screens/commitFlow.js';
import { push as gitPush, saveVersion } from '../core/gitOps.js';
import { summarize } from '../core/summarizer.js';
import { jumpToTerminal, interruptSession } from '../core/launcher.js';
import { checkForUpdate, runSelfUpdate, type UpdateCheck } from '../core/selfUpdate.js';
import { CARD_WIDTH } from './theme.js';
import type { Session } from '../core/types.js';

type Screen = 'dashboard' | 'detail' | 'new' | 'commit';

const MAX_CMD_LEN = 30;

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

  const doSummarize = useCallback(
    (session: Session, refresh = false) => {
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
    if (updating) return;
    setUpdating(true);
    say('Updating houston (pull + build)…');
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
    store.stop();
    exit();
  }, [store, exit]);

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
      { name: 'graph', aliases: ['g'], desc: 'update the knowledge graph (zero tokens)', run: () => doGraph(false) },
      { name: 'graph force', desc: 'force graph update past the shrink guard', run: () => doGraph(true) },
      { name: 'update', aliases: ['u', 'upgrade'], desc: 'update houston itself to the latest version', run: () => void doSelfUpdate() },
      { name: 'refresh', aliases: ['r'], desc: 'refresh the dashboard now', run: () => store.scheduleRefresh() },
      { name: 'help', aliases: ['?'], desc: 'show every command', run: () => setShowHelp(true) },
      { name: 'quit', aliases: ['q', 'exit'], desc: 'quit houston (your sessions keep running)', run: quit },
    ],
    [focused, focusedProject, doPush, doSaveVersion, doSummarize, doGraph, doSelfUpdate, openDetail, quit, say, store],
  );

  useInput(
    (input, key) => {
      if (showHelp) return setShowHelp(false);

      // arrows/tab always navigate, even mid-typing — they never type characters
      const last = Math.max(0, sessions.length - 1);
      if (key.leftArrow || (key.shift && key.tab)) return setFocusIdx(Math.max(0, clampedIdx - 1));
      if (key.rightArrow || key.tab) return setFocusIdx(Math.min(last, clampedIdx + 1));
      if (key.upArrow) return setFocusIdx(Math.max(0, clampedIdx - cardsPerRow));
      if (key.downArrow) return setFocusIdx(Math.min(last, clampedIdx + cardsPerRow));
      if (key.pageUp) {
        const maxOffset = Math.max(0, (snapshot?.timeline.length ?? 0) - 3);
        return setTimelineOffset((o) => Math.min(maxOffset, o + 3));
      }
      if (key.pageDown) return setTimelineOffset((o) => Math.max(0, o - 3));

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

      if (key.escape) return setCmdText('');
      if (key.backspace || key.delete) return setCmdText((t) => t.slice(0, -1));
      if (key.return) {
        const typed = cmdText.trim();
        if (!typed) return openDetail(); // enter on an empty bar = open the focused card
        const { exact, matches } = matchCommand(commands, typed);
        setCmdText('');
        if (exact) exact.run();
        else if (matches.length > 1) say(`Did you mean: ${matches.map((m) => m.name).join(', ')}?`);
        else say(`Unknown command "${typed}" — type help to see them all.`);
        return;
      }
      if (input === '?' && !cmdText) return setShowHelp(true);
      if (input && !key.ctrl && !key.meta) setCmdText((t) => (t + input).slice(0, MAX_CMD_LEN));
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
            pendingStop
              ? `Interrupt "${label(pendingStop)}"? press y to confirm, any other key cancels`
              : undefined
          }
        />
      )}
    </Box>
  );
}
