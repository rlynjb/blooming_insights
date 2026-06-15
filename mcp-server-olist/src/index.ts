// mcp-server-olist/src/index.ts
//
// Server entry point. Boots the MCP server over stdio and keeps the process
// alive until stdin closes. Logs go to stderr (the StdioServerTransport
// reserves stdout for MCP protocol frames — anything written there corrupts
// the JSON-RPC stream).

import { startServer } from './server.js';

async function main(): Promise<void> {
  try {
    await startServer();
    // stdio transport keeps the event loop alive while stdin is open; nothing
    // else to do here. We log to stderr so the parent process can see readiness
    // without polluting stdout.
    process.stderr.write('[mcp-server-olist] ready (stdio)\n');
  } catch (err) {
    process.stderr.write(
      `[mcp-server-olist] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

main();
