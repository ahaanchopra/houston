import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

// compiled location is <root>/dist/setup/registerMcp.js (dev: <root>/src/setup/…)
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export async function runSetup(): Promise<void> {
  const root = repoRoot();
  const mcpBin = path.join(root, 'bin', 'houston-mcp.js');
  const distEntry = path.join(root, 'dist', 'mcp', 'index.js');

  console.log('houston setup — registering the MCP server for all Claude sessions\n');

  if (!fs.existsSync(distEntry)) {
    console.log('• dist/ missing — running npm run build …');
    await execa('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }

  console.log('• smoke-testing houston-mcp …');
  if (!(await smokeTest(mcpBin))) {
    console.error('✗ houston-mcp crashed on startup — NOT registering it. Fix the error above first.');
    process.exitCode = 1;
    return;
  }
  console.log('  server boots cleanly.');

  console.log('• registering with Claude Code (user scope = every session):');
  console.log(`    claude mcp add -s user houston -- node ${mcpBin}\n`);
  await execa('claude', ['mcp', 'remove', '-s', 'user', 'houston'], { reject: false });
  await execa('claude', ['mcp', 'add', '-s', 'user', 'houston', '--', 'node', mcpBin], { stdio: 'inherit' });

  const { stdout, failed } = await execa('claude', ['mcp', 'get', 'houston'], { reject: false });
  console.log(stdout);
  if (failed) {
    console.error('✗ verification failed — run `claude mcp list` to inspect.');
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ Done. Any NEW Claude session can now answer "what is going on across my terminals?"');
  console.log('  via the houston tools: list_sessions, session_detail, summarize_session, stats,');
  console.log('  recent_activity, project_git_status.');
}

// A healthy stdio MCP server stays alive waiting on stdin; exiting within 1.5s = crash.
function smokeTest(mcpBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const child = spawn('node', [mcpBin], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, 1500);
    child.on('exit', () => {
      clearTimeout(timer);
      if (stderr.trim()) console.error(stderr.trim());
      finish(false);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}
