import React from 'react';
import { Box, Text } from 'ink';
import { SessionCard } from '../components/sessionCard.js';
import { TimelinePane } from '../components/timelinePane.js';
import { TranscriptPeek } from '../components/transcriptPeek.js';
import type { Session, Snapshot } from '../../core/types.js';
import type { TerminalSize } from '../hooks/useTerminalSize.js';
import { CARD_WIDTH } from '../theme.js';

const SIDE_WIDTH = 44;

export function Dashboard({
  snapshot,
  focused,
  timelineOffset,
  size,
}: {
  snapshot: Snapshot;
  focused?: Session;
  timelineOffset: number;
  size: TerminalSize;
}) {
  const showSide = size.columns >= CARD_WIDTH + SIDE_WIDTH + 4;
  const bodyHeight = Math.max(8, size.rows - 5);
  const gitByRoot = new Map(snapshot.projects.map((p) => [p.root, p.git] as const));

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="row" flexWrap="wrap" flexGrow={1} alignItems="flex-start">
        {snapshot.sessions.length === 0 && (
          <Box padding={1}>
            <Text dimColor>
              No Claude sessions found. Open Terminal and run `claude` — the card appears here instantly. Press n to
              start one from houston.
            </Text>
          </Box>
        )}
        {snapshot.sessions.map((session) => {
          const project = snapshot.projects.find((p) => p.sessionIds.includes(session.sessionId));
          return (
            <SessionCard
              key={session.sessionId}
              session={session}
              focused={focused?.sessionId === session.sessionId}
              alert={snapshot.alerts.find((a) => a.sessionId === session.sessionId)}
              git={project ? gitByRoot.get(project.root) : undefined}
            />
          );
        })}
      </Box>
      {showSide && (
        <Box flexDirection="column" width={SIDE_WIDTH}>
          <TimelinePane
            timeline={snapshot.timeline}
            height={Math.ceil(bodyHeight / 2)}
            width={SIDE_WIDTH}
            offset={timelineOffset}
          />
          <TranscriptPeek
            session={focused}
            height={Math.floor(bodyHeight / 2)}
            width={SIDE_WIDTH}
            refreshKey={snapshot.generatedAt}
          />
        </Box>
      )}
    </Box>
  );
}
