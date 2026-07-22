import React from 'react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { execa } from 'execa';
import { App } from './app.js';
import { runSetup } from '../setup/registerMcp.js';
import { runSelfUpdate } from '../core/selfUpdate.js';
import { runDaemon } from '../core/daemon.js';
import { printSnapshot } from './snapshotCmd.js';

const argv = process.argv.slice(2);

if (argv[0] === 'setup') {
  await runSetup();
} else if (argv[0] === 'daemon' && (argv[1] === 'install' || argv[1] === 'uninstall')) {
  const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/houston.js');
  if (process.platform === 'darwin') {
    // native launchd LaunchAgent: no dependencies, starts at login, restarts on crash
    const os = await import('node:os');
    const fs = await import('node:fs');
    const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(agentsDir, 'com.houston.daemon.plist');
    const logPath = path.join(os.homedir(), '.claude', 'houston', 'daemon.log');
    if (argv[1] === 'uninstall') {
      await execa('launchctl', ['unload', '-w', plistPath], { reject: false });
      fs.rmSync(plistPath, { force: true });
      console.log('[houston] daemon uninstalled.');
    } else {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.houston.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${binPath}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict></plist>
`;
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(plistPath, plist);
      await execa('launchctl', ['unload', '-w', plistPath], { reject: false }); // replace an old copy
      await execa('launchctl', ['load', '-w', plistPath], { stdio: 'inherit' });
      console.log(`[houston] daemon installed via launchd — runs at login, restarts on crash.`);
      console.log(`  log: ${logPath}   ·   remove: houston daemon uninstall`);
    }
  } else {
    // other platforms: pm2 if present (works on Windows), else manual guidance
    try {
      if (argv[1] === 'uninstall') {
        await execa('pm2', ['delete', 'houston-daemon'], { stdio: 'inherit' });
        await execa('pm2', ['save'], { stdio: 'inherit' });
        console.log('[houston] daemon removed from pm2.');
      } else {
        await execa('pm2', ['start', binPath, '--name', 'houston-daemon', '--', 'daemon'], { stdio: 'inherit' });
        await execa('pm2', ['save'], { stdio: 'inherit' });
        console.log('[houston] daemon installed — `pm2 ls` to check, `houston daemon uninstall` to remove.');
      }
    } catch (err: any) {
      console.error('[houston] pm2 not available (npm i -g pm2), or use Task Scheduler / just run `houston daemon` in any terminal.');
      console.error(String(err?.shortMessage ?? err?.message ?? err));
      process.exit(1);
    }
  }
} else if (argv[0] === 'daemon') {
  await runDaemon();
} else if (argv[0] === 'update') {
  const result = await runSelfUpdate();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
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
