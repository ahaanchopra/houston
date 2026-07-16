import React from 'react';
import { Box, Text } from 'ink';

export interface WordCommand {
  name: string;
  aliases?: string[];
  desc: string;
  available?: boolean;
  run: () => void;
}

// Full words beat single-letter hotkeys for beginners: exact name or alias wins,
// otherwise a unique prefix ("com" → commit) is enough.
export function matchCommand(
  commands: WordCommand[],
  text: string,
): { exact?: WordCommand; matches: WordCommand[] } {
  const t = text.trim().toLowerCase();
  if (!t) return { matches: [] };
  const available = commands.filter((c) => c.available !== false);
  const exact = available.find((c) => c.name === t || c.aliases?.includes(t));
  const matches = available.filter((c) => c.name.startsWith(t));
  return { exact: exact ?? (matches.length === 1 ? matches[0] : undefined), matches };
}

export function CommandBar({
  text,
  commands,
  toast,
  confirm,
  hint,
}: {
  text: string;
  commands: WordCommand[];
  toast?: string;
  confirm?: string;
  hint?: string;
}) {
  const { exact, matches } = matchCommand(commands, text);
  // an alias like "x" or "save" has no name-prefix matches but IS a valid command —
  // show what it resolves to instead of a false "no matching command"
  const shown = text ? (matches.length > 0 ? matches.slice(0, 4) : exact ? [exact] : []) : [];
  const aliasOnly = Boolean(text && exact && matches.length === 0);
  return (
    <Box flexDirection="column" paddingX={1}>
      {toast ? <Text color="cyan">{toast}</Text> : null}
      {confirm ? (
        <Text color="yellow" bold>
          {confirm}
        </Text>
      ) : (
        <>
          <Box>
            <Text color="cyan" bold>
              {'> '}
            </Text>
            <Text>{text}</Text>
            <Text color="cyan">▌</Text>
            {text && shown.length === 0 && <Text color="red">{'  '}no matching command</Text>}
            {shown.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {'   '}
                {aliasOnly
                  ? `${text.trim()} → ${exact!.name} — ${exact!.desc}`
                  : shown.map((c, i) => (i === 0 ? `${c.name} — ${c.desc}` : c.name)).join('  ·  ')}
              </Text>
            )}
          </Box>
          {!text && (
            <Text dimColor wrap="truncate-end">
              {hint ??
                'type a command + enter: commit · push · version · summarize · details · new · jump · stop · graph · update · help · quit   (arrows move focus)'}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}
