import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../theme.js';
import type { TimelineEntry } from '../../core/types.js';

export function TimelinePane({
  timeline,
  height,
  width,
  offset,
}: {
  timeline: TimelineEntry[];
  height: number;
  width: number;
  offset: number;
}) {
  const visible = Math.max(1, height - 2);
  const start = Math.min(Math.max(0, offset), Math.max(0, timeline.length - visible));
  const slice = timeline.slice(start, start + visible);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Text bold dimColor>
        recent prompts{start > 0 ? ` (↑${start})` : ''} <Text dimColor>[ [ / ] to scroll ]</Text>
      </Text>
      {slice.map((entry, i) => {
        const time = entry.timestamp
          ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '--:--';
        return (
          <Text key={`${entry.timestamp}-${i}`} wrap="truncate">
            <Text dimColor>{time}</Text> {truncate(entry.prompt.replace(/\s+/g, ' '), width - 10)}
          </Text>
        );
      })}
      {slice.length === 0 && <Text dimColor>no prompts yet</Text>}
    </Box>
  );
}
