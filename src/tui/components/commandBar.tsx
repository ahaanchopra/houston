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

// Auto-recommend: any prefix resolves to a `best` command — exact name/alias first,
// then the FIRST prefix match in registration order (so "co" recommends commit over
// complete). Enter runs `best` even when several commands share the prefix; the bar
// shows the ghost completion so what Enter will do is always visible before pressing
// it. For takesArgs commands only the first word is matched; the rest is handed to
// run() verbatim.
export function matchCommand(
  commands: WordCommand[],
  text: string,
): { exact?: WordCommand; best?: WordCommand; matches: WordCommand[]; args?: string } {
  const t = text.trim().toLowerCase();
  if (!t) return { matches: [] };
  const available = commands.filter((c) => c.available !== false);
  const exact = available.find((c) => c.name === t || c.aliases?.includes(t));
  const matches = available.filter((c) => c.name.startsWith(t));
  if (exact || matches.length > 0) {
    return {
      exact: exact ?? (matches.length === 1 ? matches[0] : undefined),
      best: exact ?? matches[0],
      matches,
    };
  }
  const spaceIdx = t.indexOf(' ');
  if (spaceIdx > 0) {
    const head = t.slice(0, spaceIdx);
    const args = text.trim().slice(spaceIdx + 1).trim();
    const argCommands = available.filter((c) => c.takesArgs);
    const headExact = argCommands.find((c) => c.name === head || c.aliases?.includes(head));
    const headMatches = argCommands.filter((c) => c.name.startsWith(head));
    const best = headExact ?? headMatches[0];
    if (best) {
      return {
        exact: headExact ?? (headMatches.length === 1 ? headMatches[0] : undefined),
        best,
        matches: headMatches.length > 0 ? headMatches : [best],
        args,
      };
    }
    return { matches: [] };
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
  const { best, matches } = matchCommand(commands, text);
  const t = text.trim().toLowerCase();
  // ghost completion: the rest of the recommended command rendered dim after the cursor,
  // fish-shell style — enter runs it even though it was never fully typed
  const ghost = best && t && !t.includes(' ') && best.name.startsWith(t) ? best.name.slice(t.length) : '';
  const others = matches.filter((c) => c !== best).slice(0, 3);
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
            {ghost ? <Text dimColor>{ghost}</Text> : null}
            {text && !best && <Text color="red">{'  '}no matching command</Text>}
            {best && text ? (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {ghost ? `— ${best.desc}` : `${best.name} — ${best.desc}`}
                {others.length > 0 ? `   ·  ${others.map((c) => c.name).join('  ·  ')}` : ''}
              </Text>
            ) : null}
          </Box>
          {!text && (
            <Text dimColor wrap="truncate-end">
              {hint ?? 'start typing — the match fills in, enter runs it (co ↵ = commit) · help = every command · arrows move focus'}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}
