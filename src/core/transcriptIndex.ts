import fs from 'node:fs';
import { readTailRecords, readHeadRecords, scanBackwards, type JsonlRecord } from './transcriptReader.js';
import type { SessionIntel } from './types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const intelCache = new Map<string, { key: string; intel: SessionIntel }>();

// A real human prompt is a `user` record whose content is a STRING; array content is a
// tool_result echo. isMeta records are system-injected context, not the human typing.
export function isHumanPrompt(rec: JsonlRecord): boolean {
  const anyRec = rec as any;
  return rec.type === 'user' && typeof anyRec.message?.content === 'string' && !anyRec.isMeta;
}

export interface TurnView {
  role: 'user' | 'assistant';
  text: string;
  tools: string[];
}

export function buildRecentTurns(tail: JsonlRecord[], count = 10, maxChars = 400): TurnView[] {
  const turns: TurnView[] = [];
  for (const rec of tail as any[]) {
    if (isHumanPrompt(rec)) {
      turns.push({ role: 'user', text: String(rec.message.content).slice(0, 1000), tools: [] });
    } else if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
      let text = '';
      const tools: string[] = [];
      for (const block of rec.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') text += `${block.text} `;
        if (block?.type === 'tool_use') {
          tools.push(block.input?.file_path ? `${block.name}(${block.input.file_path})` : String(block.name ?? 'tool'));
        }
      }
      text = text.trim();
      if (!text && tools.length === 0) continue;
      const prev = turns[turns.length - 1];
      if (prev && prev.role === 'assistant') {
        prev.text = `${prev.text} ${text}`.trim().slice(0, maxChars);
        prev.tools.push(...tools);
      } else {
        turns.push({ role: 'assistant', text: text.slice(0, maxChars), tools });
      }
    }
  }
  return turns.slice(-count);
}

export async function getIntel(transcriptPath: string): Promise<SessionIntel | undefined> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return undefined;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = intelCache.get(transcriptPath);
  if (hit && hit.key === key) return hit.intel;

  const [latest, tail, head] = await Promise.all([
    scanBackwards(transcriptPath, ['ai-title', 'last-prompt', 'assistant', 'permission-mode']),
    readTailRecords(transcriptPath),
    readHeadRecords(transcriptPath),
  ]);

  const intel: SessionIntel = { turns: 0, filesTouched: [], contextTokens: 0 };

  const title = latest.get('ai-title') as any;
  if (typeof title?.aiTitle === 'string') intel.title = title.aiTitle;

  const lastPrompt = latest.get('last-prompt') as any;
  if (typeof lastPrompt?.lastPrompt === 'string') intel.lastPrompt = lastPrompt.lastPrompt;

  const assistant = latest.get('assistant') as any;
  const usage = assistant?.message?.usage;
  if (usage) {
    intel.usage = usage;
    intel.contextTokens =
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  }
  if (typeof assistant?.message?.model === 'string') intel.model = assistant.message.model;

  const perm = latest.get('permission-mode') as any;
  if (perm) intel.permissionMode = perm.mode ?? perm.permissionMode ?? perm.value;

  const files: string[] = [];
  let turns = 0;
  let outputTokensTail = 0;
  for (const rec of tail as any[]) {
    if (isHumanPrompt(rec)) turns += 1;
    if (rec.type === 'assistant') {
      outputTokensTail += rec.message?.usage?.output_tokens ?? 0;
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && EDIT_TOOLS.has(block.name) && block.input?.file_path) {
            files.push(block.input.file_path);
          }
        }
      }
    }
  }
  intel.turns = turns;
  intel.outputTokensTail = outputTokensTail;
  intel.filesTouched = [...new Set(files)].slice(-10);

  if (!intel.lastPrompt) {
    for (let i = tail.length - 1; i >= 0; i--) {
      const rec = tail[i] as any;
      if (isHumanPrompt(rec)) {
        intel.lastPrompt = rec.message.content;
        break;
      }
    }
  }
  for (const rec of head as any[]) {
    if (isHumanPrompt(rec)) {
      intel.firstPrompt = String((rec as any).message.content);
      break;
    }
  }

  intelCache.set(transcriptPath, { key, intel });
  return intel;
}
