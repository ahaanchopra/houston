import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, fmtTokens } from '../theme.js';
import type { Snapshot } from '../../core/types.js';

export function HeaderBar({ snapshot }: { snapshot: Snapshot }) {
  const busy = snapshot.sessions.filter((s) => s.status === 'busy').length;
  const idle = snapshot.sessions.filter((s) => s.status === 'idle').length;
  const ended = snapshot.sessions.filter((s) => s.status === 'ended').length;
  const waiting = snapshot.sessions.filter((s) => s.maybeWaiting).length;
  const maxCtx = Math.max(0, ...snapshot.sessions.map((s) => s.intel?.contextTokens ?? 0));
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold color="cyan">
        HOUSTON <Text dimColor>mission control</Text>
      </Text>
      <Text>
        <Text color="green">{glyphs.busy} {busy} busy</Text>
        {'  '}
        <Text color="yellow">{glyphs.idle} {idle} idle</Text>
        {'  '}
        <Text dimColor>{glyphs.ended} {ended} ended</Text>
        {waiting > 0 && (
          <Text color="yellow">
            {'  '}
            {glyphs.waiting} {waiting} waiting?
          </Text>
        )}
        {'  '}
        <Text dimColor>ctx max {fmtTokens(maxCtx)}</Text>
        {'  '}
        <Text dimColor>{clock}</Text>
      </Text>
    </Box>
  );
}
