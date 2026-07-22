import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { ContextMeterBar } from '../components/contextMeterBar.js';
import { CommandBar, matchCommand, type WordCommand } from '../components/commandBar.js';
import { glyphs, relTime, truncate } from '../theme.js';
import { cachedSummary, summarizeInFlight, type CachedSummary } from '../../core/summarizer.js';
import { startHeadlessRun, interruptSession, jumpToTerminal } from '../../core/launcher.js';
import type { ProjectInfo, Session } from '../../core/types.js';

export function SessionDetail({
  session,
  project,
  onBack,
  onSummarize,
  say,
}: {
  session: Session;
  project?: ProjectInfo;
  onBack: () => void;
  onSummarize: (session: Session, refresh?: boolean) => void;
  say: (msg: string) => void;
}) {
  const [followUp, setFollowUp] = useState<string | undefined>();
  const [confirmStop, setConfirmStop] = useState(false);
  const [cmdText, setCmdText] = useState('');
  const summarizing = summarizeInFlight(session.sessionId);
  const summary: CachedSummary | undefined = cachedSummary(session.sessionId, session.transcriptPath);
  const isRun = session.sessionId.startsWith('run:');

  const commands: WordCommand[] = [
    { name: 'summarize', aliases: ['s'], desc: 'AI summary (cached)', run: () => onSummarize(session) },
    { name: 'resummarize', aliases: ['refresh'], desc: 'force a fresh summary', run: () => onSummarize(session, true) },
    {
      name: 'follow',
      aliases: ['f', 'follow-up'],
      desc: 'send a follow-up (forked background session)',
      available: !isRun && session.status !== 'ended',
      run: () => setFollowUp(''),
    },
    {
      name: 'stop',
      aliases: ['x', 'interrupt'],
      desc: "interrupt this session's current turn",
      available: Boolean(session.pid) && session.status !== 'ended',
      run: () => setConfirmStop(true),
    },
    {
      name: 'jump',
      aliases: ['j'],
      desc: 'bring its Terminal tab to the front',
      available: Boolean(session.pid),
      run: () => {
        if (!session.pid) return;
        void jumpToTerminal(session.pid).then((ok) => {
          if (!ok) say("Couldn't find that session's Terminal tab.");
        });
      },
    },
    { name: 'back', aliases: ['b', 'q', 'quit'], desc: 'back to the dashboard', run: onBack },
  ];

  useInput((input, key) => {
    if (followUp !== undefined) {
      // TextInput owns all keys except Esc, which cancels the follow-up
      if (key.escape) setFollowUp(undefined);
      return;
    }
    if (confirmStop) {
      if (input.toLowerCase() === 'y' && session.pid) {
        say(interruptSession(session.pid) ? 'Sent interrupt (like pressing Esc in that session).' : 'Could not signal that session.');
      }
      setConfirmStop(false);
      return;
    }
    if (key.escape) {
      if (cmdText) return setCmdText('');
      return onBack();
    }
    if (key.backspace || key.delete) return setCmdText((t) => t.slice(0, -1));
    if (key.return) {
      const typed = cmdText.trim();
      setCmdText('');
      if (!typed) return;
      const { best, args } = matchCommand(commands, typed);
      if (best) best.run(args);
      else say(`Unknown command "${typed}" — try: summarize, follow, stop, jump, back.`);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const clean = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (clean) setCmdText((t) => (t + clean).slice(0, 30));
    }
  });

  const label = session.intel?.title ?? session.name ?? session.sessionId.slice(0, 8);

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text>
        <Text bold color="cyan">{truncate(label, 60)}</Text>{' '}
        <Text dimColor>({session.sessionId.slice(0, 8)}…)</Text>{' '}
        {session.danger ? <Text color="red">{glyphs.danger} permissions bypassed</Text> : null}
      </Text>
      <Text dimColor>
        {session.cwd} · {session.intel?.model ?? 'unknown model'} · {session.status}
        {session.maybeWaiting ? ' · possibly waiting on you' : ''} · {relTime(session.lastActivityAt ?? session.endedAt)}
      </Text>
      {session.intel && session.contextWindow ? (
        <Box marginTop={1}>
          <Text>context </Text>
          <ContextMeterBar
            pct={session.contextPct ?? 0}
            tokens={session.intel.contextTokens}
            window={session.contextWindow}
            width={24}
          />
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold dimColor>
          summary {summarizing ? <Spinner type="dots" /> : summary ? `(from ${relTime(summary.generatedAt)})` : '— type summarize to generate'}
        </Text>
        {summary ? (
          <>
            <Text color="green">done:</Text>
            {summary.summary.done.map((d, i) => (
              <Text key={`d${i}`}>  ✔ {d}</Text>
            ))}
            <Text color="yellow">remaining:</Text>
            {summary.summary.remaining.map((r, i) => (
              <Text key={`r${i}`}>  ○ {r}</Text>
            ))}
            <Text>
              <Text color="cyan">focus:</Text> {summary.summary.currentFocus}
            </Text>
            {summary.summary.blockers?.length ? (
              <Text color="red">blockers: {summary.summary.blockers.join('; ')}</Text>
            ) : null}
          </>
        ) : summarizing ? (
          <Text dimColor>Haiku is reading the transcript…</Text>
        ) : (
          <Text dimColor>summarize = cheap Haiku call (cached) · resummarize = force refresh</Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>last prompt</Text>
        <Text wrap="truncate-end">{truncate(session.intel?.lastPrompt?.replace(/\s+/g, ' ') ?? '—', 200)}</Text>
        {session.intel?.filesTouched.length ? (
          <>
            <Text bold dimColor>files touched</Text>
            {session.intel.filesTouched.slice(-5).map((f) => (
              <Text key={f} dimColor>  {truncate(f, 80)}</Text>
            ))}
          </>
        ) : null}
        {project?.git?.isRepo ? (
          <Text dimColor>
            git: {project.git.branch} · {project.git.dirtyFiles} dirty +{project.git.insertions}/-{project.git.deletions}
            {project.git.ahead ? ` · ${project.git.ahead} to push` : ''}
          </Text>
        ) : null}
      </Box>

      {followUp !== undefined ? (
        <Box marginTop={1}>
          <Text color="cyan">follow-up (forked background session, esc cancels): </Text>
          <TextInput
            value={followUp}
            onChange={setFollowUp}
            onSubmit={(value) => {
              setFollowUp(undefined);
              if (!value.trim()) return;
              try {
                startHeadlessRun(session.cwd, value, { resumeSessionId: session.sessionId });
                say("Follow-up started — it won't appear in the original window; watch its card here.");
              } catch (err: any) {
                say(`Follow-up failed: ${String(err?.message ?? err).slice(0, 80)}`);
              }
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          <CommandBar
            text={cmdText}
            commands={commands}
            confirm={confirmStop ? "Interrupt this session's current turn? press y to confirm, any other key cancels" : undefined}
            hint="type a command + enter: summarize · resummarize · follow · stop · jump · back   (esc = back)"
          />
        </Box>
      )}
    </Box>
  );
}
