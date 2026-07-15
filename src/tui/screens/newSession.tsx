import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import os from 'node:os';
import fs from 'node:fs';
import { openTerminalWindow, startHeadlessRun } from '../../core/launcher.js';
import type { ProjectInfo } from '../../core/types.js';

type Step = 'project' | 'customPath' | 'prompt' | 'mode';

export function NewSession({ projects, onDone }: { projects: ProjectInfo[]; onDone: (msg?: string) => void }) {
  const [step, setStep] = useState<Step>('project');
  const [dir, setDir] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [prompt, setPrompt] = useState('');

  useInput((_input, key) => {
    if (key.escape) onDone();
  });

  const projectItems = [
    ...projects.map((p) => ({ label: p.root, value: p.root })),
    { label: `home (${os.homedir()})`, value: os.homedir() },
    { label: 'enter a path…', value: '__custom__' },
  ];

  const launch = async (mode: 'window' | 'headless') => {
    try {
      if (mode === 'window') {
        await openTerminalWindow(dir, prompt.trim() || undefined);
        onDone('Opening a new Terminal window… (first time, macOS asks to allow controlling Terminal — click OK).');
      } else {
        if (!prompt.trim()) {
          onDone('Background runs need a prompt — nothing was started.');
          return;
        }
        const run = startHeadlessRun(dir, prompt);
        onDone(`Background session started (${run.id}) — its card appears on the dashboard.`);
      }
    } catch (err: any) {
      onDone(`Launch failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        new claude session <Text dimColor>(esc to cancel)</Text>
      </Text>
      {step === 'project' && (
        <>
          <Text dimColor>where should it work?</Text>
          <SelectInput
            items={projectItems}
            onSelect={(item) => {
              if (item.value === '__custom__') {
                setStep('customPath');
              } else {
                setDir(item.value);
                setStep('prompt');
              }
            }}
          />
        </>
      )}
      {step === 'customPath' && (
        <Box>
          <Text>path: </Text>
          <TextInput
            value={customPath}
            onChange={setCustomPath}
            onSubmit={(value) => {
              const expanded = value.replace(/^~(?=$|\/)/, os.homedir());
              if (!fs.existsSync(expanded)) {
                onDone(`That folder doesn't exist: ${expanded}`);
                return;
              }
              setDir(expanded);
              setStep('prompt');
            }}
          />
        </Box>
      )}
      {step === 'prompt' && (
        <Box flexDirection="column">
          <Text dimColor>first prompt (optional for a Terminal window, required for background):</Text>
          <TextInput value={prompt} onChange={setPrompt} onSubmit={() => setStep('mode')} />
        </Box>
      )}
      {step === 'mode' && (
        <>
          <Text dimColor>run it where?</Text>
          <SelectInput
            items={[
              { label: 'New Terminal window (you drive it)', value: 'window' },
              { label: 'Background (headless — houston shows its card)', value: 'headless' },
            ]}
            onSelect={(item) => void launch(item.value as 'window' | 'headless')}
          />
        </>
      )}
    </Box>
  );
}
