import fsp from 'node:fs/promises';

// Transcript lines can be multi-MB (tool results, thinking signatures) — every reader
// here is byte-capped and never loads a whole file.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonlRecord {
  type?: string;
  [key: string]: unknown;
}

function parseLines(text: string, dropFirstPartial: boolean): JsonlRecord[] {
  const lines = text.split('\n');
  if (dropFirstPartial) lines.shift();
  const records: JsonlRecord[] = [];
  for (const line of lines) {
    if (!line || line.length > MAX_LINE_BYTES) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // partial or corrupt line
    }
  }
  return records;
}

export async function readTailRecords(file: string, maxBytes = 262144): Promise<JsonlRecord[]> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    return parseLines(buf.toString('utf8'), start > 0);
  } finally {
    await fh.close();
  }
}

export async function readHeadRecords(file: string, maxBytes = 131072): Promise<JsonlRecord[]> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, maxBytes);
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    const text = buf.toString('utf8');
    const cut = length < size ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    return parseLines(cut, false);
  } finally {
    await fh.close();
  }
}

// Scan from EOF toward BOF, returning the LATEST record of each wanted top-level type.
// Stops as soon as all types are found or the byte cap is hit.
export async function scanBackwards(
  file: string,
  wantedTypes: string[],
  opts: { maxBytes?: number; chunkBytes?: number } = {},
): Promise<Map<string, JsonlRecord>> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const chunkBytes = opts.chunkBytes ?? 65536;
  const wanted = new Set(wantedTypes);
  const found = new Map<string, JsonlRecord>();
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let end = size;
    let carry = '';
    let scanned = 0;
    while (end > 0 && scanned < maxBytes && found.size < wanted.size) {
      const start = Math.max(0, end - chunkBytes);
      const length = end - start;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      scanned += length;
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      let firstIdx = 0;
      if (start > 0) {
        // first line is partial; it completes in the next (earlier) chunk
        carry = lines[0] ?? '';
        firstIdx = 1;
      } else {
        carry = '';
      }
      for (let i = lines.length - 1; i >= firstIdx; i--) {
        const line = lines[i];
        if (!line || line.length > MAX_LINE_BYTES) continue;
        let candidate: string | undefined;
        for (const t of wanted) {
          if (!found.has(t) && (line.includes(`"type":"${t}"`) || line.includes(`"type": "${t}"`))) {
            candidate = t;
            break;
          }
        }
        if (!candidate) continue;
        try {
          const rec = JSON.parse(line) as JsonlRecord;
          if (typeof rec?.type === 'string' && wanted.has(rec.type) && !found.has(rec.type)) {
            found.set(rec.type, rec);
          }
        } catch {
          // partial line
        }
      }
      end = start;
    }
    return found;
  } finally {
    await fh.close();
  }
}
