import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { glyphs, statusColors, truncate, relTime, fmtClock, CARD_WIDTH } from './../theme.js';
import { ContextMeterBar } from './contextMeterBar.js';
import type { Alert, GitStatusInfo, ScheduleEntry, Session } from '../../core/types.js';

export function SessionCard({
  session,
  focused,
  alert,
  git,
  schedule,
  queuedCount,
  pausePct,
  index,
}: {
  session: Session;
  focused: boolean;
  alert?: Alert;
  git?: GitStatusInfo;
  schedule?: ScheduleEntry;
  // prompts waiting to be typed in when this session next goes idle
  queuedCount?: number;
  // armed usage-pause threshold (pause 50 1)
  pausePct?: number;
  // 1-based card number — how `schedule 1900 <n>` addresses a session
  index?: number;
}) {
  const inner = CARD_WIDTH - 4;
  const isCodex = session.agent === 'codex';
  const title = truncate(session.intel?.title ?? session.name ?? session.sessionId.slice(0, 8), inner - (isCodex ? 11 : 5));
  const borderColor = session.danger ? 'red' : alert ? 'yellow' : focused ? 'cyan' : 'gray';

  let statusLine: React.ReactNode;
  if (session.status === 'busy') {
    statusLine = (
      <Text color="green">
        <Spinner type="dots" /> working{session.maybeWaiting ? <Text color="yellow"> {glyphs.waiting} waiting on you?</Text> : null}
      </Text>
    );
  } else if (session.status === 'limited') {
    const resetsAt = session.intel?.limit?.resetsAt;
    statusLine = (
      <Text color="magenta">
        {glyphs.limited} limit hit{resetsAt ? ` · resets ${fmtClock(resetsAt)}` : ''}
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
        {index !== undefined ? <Text dimColor>{index} </Text> : null}
        <Text color={statusColors[session.status]}>{glyphs[session.status]}</Text>{' '}
        <Text bold>{title}</Text>
        {isCodex ? <Text color="blue"> codex</Text> : null}
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
      {schedule ? (
        <Text color="cyan">
          {glyphs.clock} {truncate(`"${schedule.prompt}" at ${fmtClock(schedule.at)}`, inner - 2)}
        </Text>
      ) : session.status === 'limited' ? (
        <Text dimColor>type schedule to auto-continue</Text>
      ) : session.status === 'ended' ? (
        <Text dimColor>✓ complete{index !== undefined ? ` ${index}` : ''} clears this card</Text>
      ) : null}
      {queuedCount ? (
        <Text color="cyan">⏭ {queuedCount} queued — sends when idle</Text>
      ) : null}
      {pausePct !== undefined ? (
        <Text color="yellow">⏸ pauses at ~{pausePct}% of 5h limit</Text>
      ) : null}
      {alert ? (
        <Text color="yellow" bold>
          {alert.kind === 'needs-input'
            ? `${glyphs.waiting} needs your input`
            : alert.kind === 'limit-hit'
              ? `${glyphs.limited} hit its usage limit`
              : '✔ finished'}
        </Text>
      ) : null}
    </Box>
  );
}
