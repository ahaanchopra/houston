import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { readTailRecords } from '../../core/transcriptReader.js';
import { buildRecentTurns, type TurnView } from '../../core/transcriptIndex.js';
import { buildCodexTurns } from '../../core/codex.js';
import { truncate } from '../theme.js';
import type { Session } from '../../core/types.js';

export function TranscriptPeek({
  session,
  height,
  width,
  refreshKey,
}: {
  session?: Session;
  height: number;
  width: number;
  refreshKey: number;
}) {
  const [turns, setTurns] = useState<TurnView[]>([]);
  const transcriptPath = session?.transcriptPath;
  const agent = session?.agent;

  useEffect(() => {
    let cancelled = false;
    if (!transcriptPath) {
      setTurns([]);
      return;
    }
    readTailRecords(transcriptPath, 65536)
      .then((tail) => {
        const count = Math.max(2, Math.floor((height - 2) / 2));
        const built = agent === 'codex' ? buildCodexTurns(tail, count, 160) : buildRecentTurns(tail, count, 160);
        if (!cancelled) setTurns(built);
      })
      .catch(() => {
        if (!cancelled) setTurns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptPath, agent, refreshKey, height]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height} overflow="hidden">
      <Text bold dimColor>
        conversation peek
      </Text>
      {turns.length === 0 && <Text dimColor>{session ? 'no transcript yet' : 'no session focused'}</Text>}
      {turns.map((turn, i) => (
        <Text key={i} wrap="truncate">
          <Text color={turn.role === 'user' ? 'cyan' : 'magenta'}>{turn.role === 'user' ? 'you' : 'ai '}</Text>{' '}
          {truncate(
            (turn.text || (turn.tools.length ? `→ ${turn.tools.join(', ')}` : '')).replace(/\s+/g, ' '),
            width - 8,
          )}
        </Text>
      ))}
    </Box>
  );
}
