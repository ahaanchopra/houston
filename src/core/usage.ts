import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectsDir, houstonDir } from './paths.js';
import type { UsageSummary } from './types.js';

// Rolling 5-hour Claude token meter. Anthropic's real limit accounting is opaque, so
// this is an ESTIMATE: it sums new-work tokens (input + output + cache creation, NOT
// cache reads) from every transcript's assistant records into 10-minute buckets. The
// cap is self-calibrated: each observed limit hit records the window total at that
// moment; % = current / max(recent samples). Until the first hit, only absolute burn
// is shown — no invented percentages.

const WINDOW_MS = 5 * 3600_000;
const BUCKET_MS = 10 * 60_000;
const WALK_INTERVAL_MS = 30_000; // directory rescans are throttled; known files read incrementally
const BACKFILL_MAX_BYTES = 4 * 1024 * 1024; // per-file cap when reconstructing the window on start
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CALIBRATION_SAMPLES = 3;
const MIN_CALIBRATION_TOKENS = 50_000; // a hit observed seconds after start would poison the cap

const calibrationFile = path.join(houstonDir, 'limit-calibration.json');
const dailyFile = path.join(houstonDir, 'usage-daily.json');

export function recordTokens(rec: any): number {
  const usage = rec?.message?.usage;
  if (rec?.type !== 'assistant' || !usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class UsageTracker {
  // per-file byte offset + partial-line carry, so each refresh reads only appended bytes
  private files = new Map<string, { offset: number; carry: string }>();
  private buckets = new Map<number, number>();
  private lastWalk = 0;
  private activeFiles: string[] = [];
  private daily: Record<string, number> = this.readDaily();
  private dailyDirty = false;

  private readDaily(): Record<string, number> {
    try {
      const raw = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  addRecord(ts: number, tokens: number, countDaily: boolean, now = Date.now()): void {
    if (tokens <= 0 || Number.isNaN(ts)) return;
    if (now - ts <= WINDOW_MS) {
      const bucket = Math.floor(ts / BUCKET_MS);
      this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + tokens);
    }
    if (countDaily) {
      const day = localDay(ts);
      this.daily[day] = (this.daily[day] ?? 0) + tokens;
      this.dailyDirty = true;
    }
  }

  windowTokens(now = Date.now()): number {
    const oldest = Math.floor((now - WINDOW_MS) / BUCKET_MS);
    let total = 0;
    for (const [bucket, tokens] of this.buckets) {
      if (bucket >= oldest) total += tokens;
      else this.buckets.delete(bucket); // prune as we go
    }
    return total;
  }

  dailyTokens(day = localDay(Date.now())): number {
    return this.daily[day] ?? 0;
  }

  summary(now = Date.now()): UsageSummary {
    const windowTokens = this.windowTokens(now);
    const cap = readCalibratedCap();
    if (cap === undefined) return { windowTokens, calibrated: false };
    return { windowTokens, pct: Math.min(100, Math.round((windowTokens / cap) * 100)), calibrated: true };
  }

  // Called when a session transitions to 'limited' — the window total right now IS
  // (approximately) the cap. Backfilled starts undercount, hence max-of-samples.
  calibrate(now = Date.now()): void {
    const tokens = this.windowTokens(now);
    if (tokens < MIN_CALIBRATION_TOKENS) return;
    let samples: Array<{ at: number; tokens: number }> = [];
    try {
      samples = JSON.parse(fs.readFileSync(calibrationFile, 'utf8')).samples ?? [];
    } catch {
      // first calibration
    }
    samples.push({ at: now, tokens });
    samples = samples.slice(-CALIBRATION_SAMPLES);
    fs.mkdirSync(houstonDir, { recursive: true });
    fs.writeFileSync(calibrationFile, JSON.stringify({ samples }, null, 2));
  }

  private walk(now: number): void {
    if (now - this.lastWalk < WALK_INTERVAL_MS && this.activeFiles.length > 0) return;
    this.lastWalk = now;
    const active: string[] = [];
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(projectsDir);
    } catch {
      this.activeFiles = [];
      return;
    }
    for (const dir of dirs) {
      const full = path.join(projectsDir, dir);
      let names: string[] = [];
      try {
        names = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(full, name);
        try {
          if (now - fs.statSync(file).mtimeMs <= WINDOW_MS) active.push(file);
        } catch {
          // vanished
        }
      }
    }
    this.activeFiles = active;
  }

  private consumeLines(text: string, countDaily: boolean, now: number): void {
    for (const line of text.split('\n')) {
      if (!line || line.length > MAX_LINE_BYTES) continue;
      try {
        const rec = JSON.parse(line);
        this.addRecord(Date.parse(rec.timestamp ?? ''), recordTokens(rec), countDaily, now);
      } catch {
        // corrupt line
      }
    }
  }

  private async readFile(file: string, now: number): Promise<void> {
    let tracker = this.files.get(file);
    let size: number;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      this.files.delete(file);
      return;
    }
    if (!tracker || size < tracker.offset) {
      // first sight (or truncation): bounded backwards backfill for the meter only —
      // daily totals come exclusively from live appends + the persisted daily file,
      // so restarts never double-count a day
      const start = Math.max(0, size - BACKFILL_MAX_BYTES);
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        this.consumeLines(start > 0 ? text.slice(text.indexOf('\n') + 1) : text, false, now);
      } finally {
        await fh.close();
      }
      this.files.set(file, { offset: size, carry: '' });
      return;
    }
    if (size === tracker.offset) return;
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - tracker.offset);
      await fh.read(buf, 0, buf.length, tracker.offset);
      let text = tracker.carry + buf.toString('utf8');
      // hold back a trailing partial line until its newline arrives
      const lastNewline = text.lastIndexOf('\n');
      tracker.carry = lastNewline === -1 ? text : text.slice(lastNewline + 1);
      text = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
      this.consumeLines(text, true, now);
      tracker.offset = size;
    } finally {
      await fh.close();
    }
  }

  async refresh(now = Date.now()): Promise<UsageSummary> {
    this.walk(now);
    for (const file of this.activeFiles) {
      try {
        await this.readFile(file, now);
      } catch {
        // one unreadable transcript must not sink the meter
      }
    }
    if (this.dailyDirty) {
      this.dailyDirty = false;
      try {
        // keep only the trailing 30 days
        const days = Object.keys(this.daily).sort().slice(-30);
        const trimmed: Record<string, number> = {};
        for (const d of days) trimmed[d] = this.daily[d];
        this.daily = trimmed;
        fs.mkdirSync(houstonDir, { recursive: true });
        fs.writeFileSync(dailyFile, JSON.stringify(this.daily, null, 2));
      } catch {
        // persistence is best-effort
      }
    }
    return this.summary(now);
  }
}

export function readCalibratedCap(): number | undefined {
  try {
    const samples: Array<{ tokens: number }> = JSON.parse(fs.readFileSync(calibrationFile, 'utf8')).samples ?? [];
    const caps = samples.map((s) => s.tokens).filter((t) => typeof t === 'number' && t > 0);
    return caps.length > 0 ? Math.max(...caps) : undefined;
  } catch {
    return undefined;
  }
}
