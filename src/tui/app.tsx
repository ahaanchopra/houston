import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { SessionStore } from '../core/store.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { HeaderBar } from './components/headerBar.js';
import { ActionBar } from './components/actionBar.js';
import { HelpOverlay } from './components/helpOverlay.js';
import { Dashboard } from './screens/dashboard.js';
import { SessionDetail } from './screens/sessionDetail.js';
import { NewSession } from './screens/newSession.js';
import { CommitFlow } from './screens/commitFlow.js';
import { push as gitPush, saveVersion } from '../core/gitOps.js';
import { summarize } from '../core/summarizer.js';
import { jumpToTerminal } from '../core/launcher.js';
import { CARD_WIDTH } from './theme.js';
import type { Session } from '../core/types.js';

type Screen = 'dashboard' | 'detail' | 'new' | 'commit';

export function App() {
  const { exit } = useApp();
  const store = useMemo(() => new SessionStore(), []);
  const snapshot = useStore(store);
  const size = useTerminalSize();
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [focusIdx, setFocusIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [toast, setToast] = useState<string | undefined>();

  const sessions = snapshot?.sessions ?? [];
  const clampedIdx = Math.min(focusIdx, Math.max(0, sessions.length - 1));
  const focused: Session | undefined = sessions[clampedIdx];
  const focusedProject = snapshot?.projects.find((p) => focused && p.sessionIds.includes(focused.sessionId));
  const focusedProjectBusy = Boolean(
    focusedProject &&
      sessions.some((s) => focusedProject.sessionIds.includes(s.sessionId) && s.status === 'busy'),
  );
  const cardsPerRow = Math.max(1, Math.floor((size.columns - 46) / CARD_WIDTH));

  const say = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((current) => (current === msg ? undefined : current)), 8000);
  }, []);

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
          say('Summary ready — press Enter on the card for details.');
          store.scheduleRefresh();
        })
        .catch((err) => say(`Summary failed: ${String(err?.message ?? err).slice(0, 100)}`));
    },
    [say, store],
  );

  const doPush = useCallback(async () => {
    if (!focusedProject?.isRepo) return say('Not a git repo — press c to set one up first.');
    say('Pushing…');
    const res = await gitPush(focusedProject.root);
    say(res.ok ? res.message : `${res.message}${res.suggestion ? ` → ${res.suggestion}` : ''}`);
  }, [focusedProject, say]);

  const doSaveVersion = useCallback(async () => {
    if (!focusedProject?.isRepo) return say('Not a git repo — press c to set one up first.');
    try {
      const tag = await saveVersion(focusedProject.root);
      say(`✔ saved version ${tag} — press p to push it to GitHub.`);
    } catch (err: any) {
      say(`Save failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }, [focusedProject, say]);

  useInput(
    (input, key) => {
      if (showHelp) return setShowHelp(false);
      if (input === '?') return setShowHelp(true);
      if (input === 'q') {
        store.stop();
        exit();
        return;
      }
      const last = Math.max(0, sessions.length - 1);
      if (key.leftArrow || (key.shift && key.tab)) setFocusIdx(Math.max(0, clampedIdx - 1));
      else if (key.rightArrow || key.tab) setFocusIdx(Math.min(last, clampedIdx + 1));
      else if (key.upArrow) setFocusIdx(Math.max(0, clampedIdx - cardsPerRow));
      else if (key.downArrow) setFocusIdx(Math.min(last, clampedIdx + cardsPerRow));
      else if (key.return && focused) {
        store.dismissAlert(focused.sessionId);
        setScreen('detail');
      } else if (input === 'c') setScreen('commit');
      else if (input === 'p') void doPush();
      else if (input === 'v') void doSaveVersion();
      else if (input === 's' && focused) doSummarize(focused);
      else if (input === 'n') setScreen('new');
      else if (input === 'j' && focused?.pid) {
        void jumpToTerminal(focused.pid).then((ok) => {
          if (!ok) say("Couldn't find that session's Terminal tab (only Terminal.app windows are searchable).");
        });
      } else if (input === 'r') store.scheduleRefresh();
      else if (input === '[') setTimelineOffset((o) => o + 3);
      else if (input === ']') setTimelineOffset((o) => Math.max(0, o - 3));
      else if ((input === 'g' || input === 'G') && focusedProject) {
        if (!focusedProject.hasGraphify) return say('No graphify-out/ in this project — run /graphify there once first.');
        say(input === 'G' ? 'Force-updating knowledge graph…' : 'Updating knowledge graph…');
        void store.graphify.update(focusedProject.root, input === 'G').then(() => {
          const state = store.graphify.stateFor(focusedProject.root);
          say(state?.lastError ?? '✔ knowledge graph updated (zero tokens).');
        });
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
      <HeaderBar snapshot={snapshot} />
      {showHelp ? (
        <HelpOverlay />
      ) : screen === 'dashboard' ? (
        <Dashboard snapshot={snapshot} focused={focused} timelineOffset={timelineOffset} size={size} />
      ) : screen === 'detail' && focused ? (
        <SessionDetail
          session={focused}
          project={focusedProject}
          onBack={() => setScreen('dashboard')}
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
      ) : screen === 'commit' ? (
        <CommitFlow
          project={focusedProject}
          projectBusy={focusedProjectBusy}
          onDone={(msg) => {
            setScreen('dashboard');
            if (msg) say(msg);
            store.scheduleRefresh();
          }}
        />
      ) : null}
      {screen === 'dashboard' && !showHelp && <ActionBar toast={toast} />}
    </Box>
  );
}
