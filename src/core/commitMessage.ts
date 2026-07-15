import { runHaikuJson } from './headless.js';

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', maxLength: 72 },
    body: { type: 'string' },
  },
  required: ['subject'],
};

export interface CommitMessage {
  subject: string;
  body?: string;
}

export async function generateCommitMessage(files: string[], diff: string): Promise<CommitMessage> {
  const prompt = [
    'Write a git commit message for the following staged changes.',
    'Subject: conventional-commit style (feat:/fix:/refactor:/docs:/test:/chore:), under 72 characters.',
    'Body: short plain English, only if it adds real information beyond the subject.',
    '',
    `Files changed:\n${files.slice(0, 50).join('\n')}`,
    '',
    'Diff (truncated):',
    diff,
  ].join('\n');
  try {
    const { payload } = await runHaikuJson(prompt, COMMIT_SCHEMA, { maxBudgetUsd: '0.05', timeoutMs: 60_000 });
    if (typeof payload?.subject === 'string' && payload.subject.trim()) {
      return { subject: payload.subject.trim().slice(0, 72), body: payload.body };
    }
  } catch {
    // fall through to the deterministic fallback
  }
  return { subject: `chore: update ${files.length} file${files.length === 1 ? '' : 's'}` };
}
