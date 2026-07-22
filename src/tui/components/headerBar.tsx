import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, fmtTokens } from '../theme.js';
import type { Snapshot } from '../../core/types.js';

export function HeaderBar({ snapshot, updateAvailable }: { snapshot: Snapshot; updateAvailable?: boolean }) {
  const busy = snapshot.sessions.filter((s) => s.status === 'busy').length;
  const limited = snapshot.sessions.filter((s) => s.status === 'limited').length;
  const idle = snapshot.sessions.filter((s) => s.status === 'idle').length;
  const ended = snapshot.sessions.filter((s) => s.status === 'ended').length;
  const waiting = snapshot.sessions.filter((s) => s.maybeWaiting).length;
  const maxCtx = Math.max(0, ...snapshot.sessions.map((s) => s.intel?.contextTokens ?? 0));
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold color="cyan">
        HOUSTON <Text dimColor>mission control</Text>
        {updateAvailable ? <Text color="magenta">  ⬆ update available — type update</Text> : null}
      </Text>
      <Text>
        <Text color="green">{glyphs.busy} {busy} busy</Text>
        {'  '}
        {limited > 0 && (
          <Text color="magenta">
            {glyphs.limited} {limited} at limit{'  '}
          </Text>
        )}
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
