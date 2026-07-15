export type SessionStatus = 'busy' | 'idle' | 'ended';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  [key: string]: unknown;
}

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

export interface SessionIntel {
  title?: string;
  lastPrompt?: string;
  firstPrompt?: string;
  turns: number;
  usage?: UsageInfo;
  model?: string;
  contextTokens: number;
  outputTokensTail?: number;
  filesTouched: string[];
  permissionMode?: string;
}

export interface Session {
  sessionId: string;
  pid?: number;
  name?: string;
  cwd: string;
  status: SessionStatus;
  rawStatus?: string;
  kind?: string;
  startedAt?: number;
  statusUpdatedAt?: number;
  endedAt?: number;
  endReason?: 'exited' | 'crashed';
  maybeWaiting?: boolean;
  danger?: boolean;
  transcriptPath?: string;
  transcriptMtimeMs?: number;
  // freshest sign of life: max(statusUpdatedAt, transcript mtime) — registry timestamps
  // go stale during long turns while the transcript is written continuously
  lastActivityAt?: number;
  intel?: SessionIntel;
  contextPct?: number;
  contextWindow?: number;
  isHoustonChild?: boolean;
}

export interface TimelineEntry {
  prompt: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

export interface GitStatusInfo {
  isRepo: boolean;
  branch?: string;
  dirtyFiles: number;
  insertions: number;
  deletions: number;
  ahead: number;
  behind: number;
  lastCommit?: string;
}

export interface ProjectInfo {
  root: string;
  cwds: string[];
  isRepo: boolean;
  hasGraphify: boolean;
  git?: GitStatusInfo;
  sessionIds: string[];
}

export interface Alert {
  kind: 'needs-input' | 'finished';
  sessionId: string;
  at: number;
  title?: string;
}

export interface Snapshot {
  sessions: Session[];
  timeline: TimelineEntry[];
  projects: ProjectInfo[];
  alerts: Alert[];
  generatedAt: number;
}

export interface Summary {
  done: string[];
  remaining: string[];
  currentFocus: string;
  blockers?: string[];
}
