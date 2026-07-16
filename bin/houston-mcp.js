#!/usr/bin/env node
import('../dist/mcp/index.js').catch((err) => {
  console.error('[houston-mcp] failed to start. If dist/ is missing, run: npm run build');
  console.error(String(err?.message ?? err));
  process.exit(1);
});
