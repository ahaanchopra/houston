import { historyFile } from './paths.js';
import { readTailRecords } from './transcriptReader.js';
import type { TimelineEntry } from './types.js';

// history.jsonl entries carry multi-KB pastedContents, so a fixed 64KB tail can hold far
// fewer than `limit` prompts — grow the read until we have enough (capped at 1MB).
const TAIL_STEPS = [65536, 262144, 1048576];

export async function readTimeline(limit = 50, file = historyFile): Promise<TimelineEntry[]> {
  let records: any[] = [];
  for (const maxBytes of TAIL_STEPS) {
    try {
      records = await readTailRecords(file, maxBytes);
    } catch {
      return [];
    }
    const usable = records.filter((r) => typeof r.display === 'string').length;
    if (usable >= limit) break;
  }
  return records
    .filter((r) => typeof r.display === 'string')
    .slice(-limit)
    .reverse()
    .map((r) => ({
      prompt: r.display as string,
      project: typeof r.project === 'string' ? r.project : '',
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
      timestamp: typeof r.timestamp === 'number' ? r.timestamp : 0,
    }));
}
