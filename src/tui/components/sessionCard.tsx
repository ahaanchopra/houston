import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { glyphs, statusColors, truncate, relTime, CARD_WIDTH } from './../theme.js';
import { ContextMeterBar } from './contextMeterBar.js';
import type { Alert, GitStatusInfo, Session } from '../../core/types.js';

export function SessionCard({
  session,
  focused,
  alert,
  git,
}: {
  session: Session;
  focused: boolean;
  alert?: Alert;
  git?: GitStatusInfo;
}) {
  const inner = CARD_WIDTH - 4;
  const title = truncate(session.intel?.title ?? session.name ?? session.sessionId.slice(0, 8), inner - 2);
  const borderColor = session.danger ? 'red' : alert ? 'yellow' : focused ? 'cyan' : 'gray';

  let statusLine: React.ReactNode;
  if (session.status === 'busy') {
    statusLine = (
      <Text color="green">
        <Spinner type="dots" /> working{session.maybeWaiting ? <Text color="yellow"> {glyphs.waiting} waiting on you?</Text> : null}
      </Text>
    );
  } else if (session.status === 'idle') {
    statusLine = <Text color="yellow">{glyphs.idle} your turn</Text>;
  } else {
    statusLine = (
      <Text dimColor>
        {glyphs.ended} ended{session.endReason === 'crashed' ? ' (crashed or closed)' : ''}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} width={CARD_WIDTH} paddingX={1}>
      <Text>
        <Text color={statusColors[session.status]}>{glyphs[session.status]}</Text>{' '}
        <Text bold>{title}</Text>
        {session.danger ? <Text color="red"> {glyphs.danger}</Text> : null}
      </Text>
      <Text>{statusLine}</Text>
      {session.intel && session.contextWindow ? (
        <ContextMeterBar pct={session.contextPct ?? 0} tokens={session.intel.contextTokens} window={session.contextWindow} />
      ) : (
        <Text dimColor>{truncate(session.cwd, inner)}</Text>
      )}
      <Text dimColor>
        {git?.isRepo && git.dirtyFiles > 0
          ? truncate(`${glyphs.dirty} ${git.dirtyFiles} files +${git.insertions}/-${git.deletions}`, inner - 10)
          : truncate(session.cwd.split('/').slice(-1)[0] ?? '', inner - 10)}
        {'  '}
        {relTime(session.lastActivityAt ?? session.endedAt ?? session.startedAt)}
      </Text>
      {alert ? (
        <Text color="yellow" bold>
          {alert.kind === 'needs-input' ? `${glyphs.waiting} needs your input` : '✔ finished'}
        </Text>
      ) : null}
    </Box>
  );
}
