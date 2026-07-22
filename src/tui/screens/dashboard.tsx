import React from 'react';
import { Box, Text } from 'ink';
import { SessionCard } from '../components/sessionCard.js';
import { TimelinePane } from '../components/timelinePane.js';
import { TranscriptPeek } from '../components/transcriptPeek.js';
import type { Session, Snapshot } from '../../core/types.js';
import type { TerminalSize } from '../hooks/useTerminalSize.js';
import { CARD_WIDTH } from '../theme.js';

export const SIDE_WIDTH = 44;

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
  // cap the grid to what fits on screen — an unbounded wrap grid pushes the action bar
  // off-terminal and makes Ink redraw the full scrollback
  const cardArea = showSide ? size.columns - SIDE_WIDTH : size.columns;
  const cardsPerRow = Math.max(1, Math.floor(cardArea / CARD_WIDTH));
  const maxCards = Math.max(cardsPerRow, Math.floor(bodyHeight / 6) * cardsPerRow);
  const visibleSessions = snapshot.sessions.slice(0, maxCards);
  const hiddenCount = snapshot.sessions.length - visibleSessions.length;

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
        {visibleSessions.map((session, i) => {
          const project = snapshot.projects.find((p) => p.sessionIds.includes(session.sessionId));
          return (
            <SessionCard
              key={session.sessionId}
              session={session}
              focused={focused?.sessionId === session.sessionId}
              alert={snapshot.alerts.find((a) => a.sessionId === session.sessionId)}
              git={project ? gitByRoot.get(project.root) : undefined}
              schedule={snapshot.schedules.find((s) => s.sessionId === session.sessionId)}
              queuedCount={snapshot.queue.filter((q) => q.sessionId === session.sessionId).length}
              pausePct={snapshot.pauses.find((p) => p.sessionId === session.sessionId)?.pct}
              index={i + 1}
            />
          );
        })}
        {hiddenCount > 0 && (
          <Box padding={1}>
            <Text dimColor>+{hiddenCount} more session{hiddenCount === 1 ? '' : 's'} (mostly ended) not shown</Text>
          </Box>
        )}
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
