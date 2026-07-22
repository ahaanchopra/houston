import React from 'react';
import { Box, Text } from 'ink';

const ROWS: Array<[string, string]> = [
  ['arrows / tab', 'move focus between session cards'],
  ['enter', 'open the focused session (empty command bar)'],
  ['commit', 'stage changes — AI writes the message, you edit & approve'],
  ['push', 'push the focused project to GitHub'],
  ['version', 'save a checkpoint (commit if needed + tag save-…)'],
  ['summarize', 'AI summary of the focused session (done / remaining)'],
  ['details', 'open the focused session'],
  ['new', 'start a new Claude session (Terminal window or background)'],
  ['jump', 'bring the Terminal tab running that session to the front'],
  ['stop', "interrupt the focused session's current turn"],
  ['schedule', 'auto-continue later: schedule 1900 2 = send "continue" to card 2 at 19:00 · times: 1900, 730, 7:30am'],
  ['unschedule', 'cancel an auto-continue: unschedule [card#] (no number = focused card)'],
  ['complete', 'mark a card done and hide it: complete 1 (or complete one) · comes back if the session gets active'],
  ['graphify', 'type "update graphify" into that Claude session: graphify 1 (or graphify one)'],
  ['graph', 'update the knowledge graph (graph force = override guard)'],
  ['update', 'update houston itself to the latest version'],
  ['pgup / pgdn', 'scroll the prompt timeline'],
  ['refresh', 'refresh the dashboard now'],
  ['quit', 'quit houston (your Claude sessions keep running)'],
];

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        houston — commands (type the word, press enter · short prefixes work too: "com" → commit)
      </Text>
      {ROWS.map(([key, desc]) => (
        <Text key={key}>
          <Text color="cyan">{key.padEnd(14)}</Text> {desc}
        </Text>
      ))}
      <Text dimColor>press any key to close</Text>
    </Box>
  );
}
