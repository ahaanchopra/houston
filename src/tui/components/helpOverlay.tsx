import React from 'react';
import { Box, Text } from 'ink';

const ROWS: Array<[string, string]> = [
  ['←→↑↓ / Tab', 'move focus between session cards'],
  ['Enter', 'open session details (summary, git, follow-up, stop)'],
  ['c', 'commit the focused project (AI writes the message, you approve)'],
  ['p', 'push the focused project to GitHub'],
  ['v', 'save a version (commit if needed + tag save-YYYYMMDD-HHMMSS)'],
  ['s', 'AI summary of the focused session (what is done / what is left)'],
  ['n', 'start a new Claude session (Terminal window or background)'],
  ['j', 'jump to the Terminal tab running the focused session'],
  ['g / G', 'update the knowledge graph (G = force past the shrink guard)'],
  ['[ / ]', 'scroll the prompt timeline'],
  ['r', 'refresh now'],
  ['q', 'quit houston (your Claude sessions keep running)'],
];

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        houston — keys
      </Text>
      {ROWS.map(([key, desc]) => (
        <Text key={key}>
          <Text color="cyan">{key.padEnd(12)}</Text> {desc}
        </Text>
      ))}
      <Text dimColor>press any key to close</Text>
    </Box>
  );
}
