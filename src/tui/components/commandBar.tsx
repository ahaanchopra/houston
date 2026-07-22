import React from 'react';
import { Box, Text } from 'ink';

export interface WordCommand {
  name: string;
  aliases?: string[];
  desc: string;
  available?: boolean;
  // commands like `schedule 7:30 continue` take everything after the first word as args
  takesArgs?: boolean;
  run: (args?: string) => void;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Card numbers can be typed as digits or words: "graphify 1" and "graphify one" both work.
export function parseCardNumber(token?: string): number | undefined {
  if (!token) return undefined;
  const t = token.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) return Number(t);
  return WORD_NUMBERS[t];
}

// Full words beat single-letter hotkeys for beginners: exact name or alias wins,
// otherwise a unique prefix ("com" → commit) is enough. For takesArgs commands only
// the first word is matched; the rest is handed to run() verbatim.
export function matchCommand(
  commands: WordCommand[],
  text: string,
): { exact?: WordCommand; matches: WordCommand[]; args?: string } {
  const t = text.trim().toLowerCase();
  if (!t) return { matches: [] };
  const available = commands.filter((c) => c.available !== false);
  const exact = available.find((c) => c.name === t || c.aliases?.includes(t));
  const matches = available.filter((c) => c.name.startsWith(t));
  if (exact || matches.length > 0) {
    return { exact: exact ?? (matches.length === 1 ? matches[0] : undefined), matches };
  }
  const spaceIdx = t.indexOf(' ');
  if (spaceIdx > 0) {
    const head = t.slice(0, spaceIdx);
    const args = text.trim().slice(spaceIdx + 1).trim();
    const argCommands = available.filter((c) => c.takesArgs);
    const headExact = argCommands.find((c) => c.name === head || c.aliases?.includes(head));
    const headMatches = argCommands.filter((c) => c.name.startsWith(head));
    const resolved = headExact ?? (headMatches.length === 1 ? headMatches[0] : undefined);
    if (resolved) return { exact: resolved, matches: [resolved], args };
    return { matches: headMatches };
  }
  return { matches: [] };
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
                'type a command + enter: commit · push · version · summarize · details · new · jump · stop · schedule · complete · graphify · graph · update · help · quit   (arrows move focus)'}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}
