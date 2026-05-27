// lib/mcp/transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** Minimal surface McpClient depends on. Real impl wraps the MCP SDK Client;
 *  tests provide a fake. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Wraps a connected MCP SDK Client. Connection/auth handled in auth.ts/connect.ts. */
export class SdkTransport implements McpTransport {
  constructor(private client: Client) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.callTool({ name, arguments: args });
    return res;
  }
}
