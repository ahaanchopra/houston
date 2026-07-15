import stringWidth from 'string-width';
import type { SessionStatus } from '../core/types.js';

export const glyphs = {
  busy: '●',
  idle: '○',
  ended: '✕',
  danger: '⚠',
  waiting: '▲',
  dirty: '±',
} as const;

export const statusColors: Record<SessionStatus, string> = {
  busy: 'green',
  idle: 'yellow',
  ended: 'gray',
};

export const CARD_WIDTH = 36;

// slice() breaks card borders on emoji/CJK (they render 2 columns wide) — always
// truncate by display width, not code units.
export function truncate(text: string, max: number): string {
  if (max <= 1) return '…';
  if (stringWidth(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (stringWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function meterBar(pct: number, width = 12): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function meterColor(pct: number): string {
  if (pct > 85) return 'red';
  if (pct > 60) return 'yellow';
  return 'green';
}

export function relTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function fmtTokens(n?: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
