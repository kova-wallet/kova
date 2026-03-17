// MCP Server — the sole agent-facing interface for the wallet.
// Tool definitions, validation, and sanitization are internal implementation
// details used by the MCP adapter and not part of the public API.
export { createMcpServer, createMcpStdioServer } from "./mcp.js";
export type { McpServerOptions } from "./mcp.js";
