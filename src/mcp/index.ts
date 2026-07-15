import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDirs } from '../core/paths.js';
import { registerTools } from './tools.js';

// This server is registered at USER scope, so a crash here would show a failed-server
// warning in EVERY Claude session — bootstrap defensively and log to stderr only
// (stdout belongs to the MCP stdio transport).
async function main(): Promise<void> {
  ensureDirs();
  const server = new McpServer({ name: 'houston', version: '0.1.0' });
  registerTools(server);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[houston-mcp] fatal:', err);
  process.exit(1);
});
