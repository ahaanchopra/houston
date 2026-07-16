import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { stageAllAndDiff, commitStaged, riskyFiles, initRepo, push as gitPush } from '../../core/gitOps.js';
import { generateCommitMessage } from '../../core/commitMessage.js';
import { truncate } from '../theme.js';
import type { ProjectInfo } from '../../core/types.js';

type Step =
  | 'offer-init'
  | 'busy-confirm'
  | 'staging'
  | 'risky'
  | 'generating'
  | 'edit'
  | 'committing'
  | 'done'
  | 'pushing'
  | 'nothing'
  | 'error';

export function CommitFlow({
  project,
  projectBusy,
  onDone,
}: {
  project?: ProjectInfo;
  projectBusy: boolean;
  onDone: (msg?: string) => void;
}) {
  const [step, setStep] = useState<Step>(() => {
    if (!project) return 'error';
    if (!project.isRepo) return 'offer-init';
    return projectBusy ? 'busy-confirm' : 'staging';
  });
  const [files, setFiles] = useState<string[]>([]);
  const [risky, setRisky] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [body, setBody] = useState<string | undefined>();
  const [error, setError] = useState('Nothing to commit here.');
  const [commitHash, setCommitHash] = useState('');

  const beginStaging = async () => {
    if (!project) return;
    setStep('staging');
    try {
      const staged = await stageAllAndDiff(project.root);
      if (staged.files.length === 0) {
        setStep('nothing');
        return;
      }
      setFiles(staged.files);
      const risk = riskyFiles(project.root, staged.files);
      if (risk.length > 0) {
        setRisky(risk);
        setStep('risky');
        return;
      }
      await generate(staged.files, staged.diff);
    } catch (err: any) {
      setError(String(err?.message ?? err).slice(0, 120));
      setStep('error');
    }
  };

  const generate = async (stagedFiles: string[], diff: string) => {
    setStep('generating');
    const msg = await generateCommitMessage(stagedFiles, diff);
    setMessage(msg.subject);
    setBody(msg.body);
    setStep('edit');
  };

  useEffect(() => {
    if (step === 'staging') void beginStaging();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((rawInput, key) => {
    // Esc always cancels — including at the edit step, where TextInput owns every
    // other key but ignores Escape
    if (key.escape) return onDone();
    if (step === 'edit' || step === 'pushing') return;
    const input = rawInput.toLowerCase();
    if (step === 'offer-init' && input === 'y' && project) {
      void initRepo(project.root)
        .then(() => beginStaging())
        .catch((err) => {
          setError(String(err?.message ?? err).slice(0, 120));
          setStep('error');
        });
    } else if (step === 'offer-init' && input === 'n') {
      onDone();
    } else if (step === 'busy-confirm') {
      if (input === 'y') void beginStaging();
      else onDone();
    } else if (step === 'risky') {
      if (input === 'y' && project) {
        void stageAllAndDiff(project.root)
          .then((s) => generate(s.files, s.diff))
          .catch((err) => {
            setError(String(err?.message ?? err).slice(0, 120));
            setStep('error');
          });
      } else {
        onDone('Commit cancelled — remove the risky files or add them to .gitignore first.');
      }
    } else if (step === 'done') {
      if (input === 'p' && project) {
        setStep('pushing');
        void gitPush(project.root)
          .then((res) => onDone(res.ok ? `✔ ${res.message}` : `${res.message}${res.suggestion ? ` → ${res.suggestion}` : ''}`))
          .catch((err) => onDone(`Push failed: ${String(err?.message ?? err).slice(0, 100)}`));
      } else {
        onDone();
      }
    } else if (step === 'nothing' || step === 'error') {
      onDone();
    }
  });

  if (!project) return <Text color="red">No project focused — press esc.</Text>;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        commit — {project.root} <Text dimColor>(esc to cancel)</Text>
      </Text>
      {step === 'offer-init' && (
        <Text>
          This folder isn't a git repo yet. Set one up (creates .gitignore + git init)? <Text color="cyan">[y/n]</Text>
        </Text>
      )}
      {step === 'busy-confirm' && (
        <Text color="yellow">
          A Claude session is still working in this project — files may be mid-edit. Commit anyway? [y/n]
        </Text>
      )}
      {step === 'staging' && (
        <Text>
          <Spinner type="dots" /> staging changes…
        </Text>
      )}
      {step === 'risky' && (
        <>
          <Text color="red" bold>
            ⚠ these files look like secrets or oversized artifacts:
          </Text>
          {risky.slice(0, 8).map((f) => (
            <Text key={f} color="red">  {f}</Text>
          ))}
          <Text>
            Committing secrets to GitHub is hard to undo. Commit them anyway? <Text color="cyan">[y = yes, anything else = cancel]</Text>
          </Text>
        </>
      )}
      {step === 'generating' && (
        <>
          <Text dimColor>{files.length} files staged</Text>
          <Text>
            <Spinner type="dots" /> writing a commit message with Haiku…
          </Text>
        </>
      )}
      {step === 'edit' && (
        <>
          <Text dimColor>{files.length} files staged. Edit the message, Enter to commit:</Text>
          <Box>
            <Text color="cyan">msg: </Text>
            <TextInput
              value={message}
              onChange={setMessage}
              onSubmit={(value) => {
                if (!value.trim()) return;
                setStep('committing');
                void commitStaged(project.root, body ? `${value}\n\n${body}` : value)
                  .then((hash) => {
                    setCommitHash(hash);
                    setStep('done');
                  })
                  .catch((err) => {
                    setError(String(err?.message ?? err).slice(0, 120));
                    setStep('error');
                  });
              }}
            />
          </Box>
          {body ? <Text dimColor>{truncate(body.replace(/\s+/g, ' '), 100)}</Text> : null}
        </>
      )}
      {step === 'committing' && (
        <Text>
          <Spinner type="dots" /> committing…
        </Text>
      )}
      {step === 'pushing' && (
        <Text>
          <Spinner type="dots" /> pushing to GitHub…
        </Text>
      )}
      {step === 'done' && (
        <Text color="green">
          ✔ committed {commitHash.slice(0, 7)} — press <Text color="cyan">p</Text> to push to GitHub, anything else to go back.
        </Text>
      )}
      {step === 'nothing' && <Text dimColor>Nothing to commit — press any key.</Text>}
      {step === 'error' && <Text color="red">{error} — press any key.</Text>}
    </Box>
  );
}
