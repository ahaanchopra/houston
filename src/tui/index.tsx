import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { runSetup } from '../setup/registerMcp.js';
import { printSnapshot } from './snapshotCmd.js';

const argv = process.argv.slice(2);

if (argv[0] === 'setup') {
  await runSetup();
} else if (argv.includes('--snapshot')) {
  await printSnapshot();
} else if (!process.stdout.isTTY || !process.stdin.isTTY) {
  // Ink needs a real terminal; without this guard, running houston inside a pipe (or a
  // Claude session's Bash tool) would wedge on raw-mode.
  console.error('houston needs an interactive terminal.');
  console.error('Open Terminal.app and run `houston` there — or use `houston --snapshot` for a one-shot text status.');
  process.exit(1);
} else {
  render(<App />);
}
