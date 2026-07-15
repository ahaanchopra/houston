import React from 'react';
import { Text } from 'ink';
import { meterBar, meterColor, fmtTokens } from '../theme.js';

export function ContextMeterBar({
  pct,
  tokens,
  window,
  width = 12,
}: {
  pct: number;
  tokens: number;
  window: number;
  width?: number;
}) {
  return (
    <Text>
      <Text color={meterColor(pct)}>{meterBar(pct, width)}</Text>
      <Text dimColor>
        {' '}
        {pct}% <Text>({fmtTokens(tokens)}/{fmtTokens(window)})</Text>
      </Text>
    </Text>
  );
}
