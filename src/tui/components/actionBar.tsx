import React from 'react';
import { Box, Text } from 'ink';

export function ActionBar({ toast }: { toast?: string }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {toast ? <Text color="cyan">{toast}</Text> : null}
      <Text dimColor>
        [enter]details [c]ommit [p]ush [v]save-version [s]ummarize [n]ew [j]ump [g]raph [[]/[]]timeline [?]help [q]uit
      </Text>
    </Box>
  );
}
