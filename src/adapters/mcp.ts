/**
 * MCP (Model Context Protocol) adapter — exposes wallet tools via an MCP server.
 *
 * This is the sole agent-facing interface for the wallet. All AI agents interact
 * with the wallet through this MCP server, regardless of the AI framework used
 * (Claude, OpenAI, LangChain, custom).
 *
 * Uses the low-level Server API from @modelcontextprotocol/sdk to register
 * wallet tools with raw JSON schemas (matching the canonical tool definitions
 * in tools.ts) rather than Zod schemas.
 *
 * Security measures (matching existing adapter patterns):
 * - Input validation via safeHandleToolCall (HIGH-16)
 * - Response sanitization via sanitizeToolResponse (CRIT-T3-01)
 * - Execution timeout via Promise.race (A-11)
 * - Generic error messages on failure (A-12)
 * - Auth token forwarding (A-14)
 * - Concurrency limiting (A-16)
 * - Read rate limiting (A-15, handled by safeHandleToolCall)
 * - Write rate limiting (handled by wallet.handleToolCall)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getFilteredTools,
  safeHandleToolCall,
  sanitizeToolResponse,
  TOOL_CALL_TIMEOUT_MS,
} from "./tools.js";

/**
 * Minimal wallet interface for MCP adapter usage.
 * Avoids coupling to the full AgentWallet class.
 */
interface AgentWalletLike {
  handleToolCall: (
    name: string,
    input: Record<string, unknown>,
    authToken?: string,
  ) => Promise<unknown>;
}

/**
 * Maximum number of concurrent tool calls per MCP server instance.
 * Prevents a runaway agent from overwhelming the wallet with parallel requests.
 */
const MAX_CONCURRENT_CALLS = 10;

/** Options for creating an MCP server from a wallet instance. */
export interface McpServerOptions {
  /** Include dangerous tools (wallet_execute_custom). */
  includeDangerous?: boolean;
  /** Exclude specific tools by name. */
  exclude?: string[];
  /** Static auth token forwarded to wallet.handleToolCall on every call. */
  authToken?: string;
  /**
   * Optional function that returns the current auth token on each call.
   * When set, this is called on every tool call invocation to support
   * token rotation. Falls back to the static authToken if not provided.
   */
  authTokenProvider?: () => string | undefined;
  /** Override the MCP server name and version. */
  serverInfo?: { name?: string; version?: string };
}

/**
 * Create an MCP Server instance with all wallet tools registered.
 *
 * The returned Server is not yet connected to a transport — call
 * `server.connect(transport)` with a StdioServerTransport, SSE transport,
 * or any other MCP-compatible transport.
 *
 * @param wallet - Wallet instance with handleToolCall method
 * @param options - Optional filtering, auth, and server info options
 * @returns A configured MCP Server ready to be connected to a transport
 *
 * @example
 * ```typescript
 * import { AgentWallet } from "@kova-sdk/wallet";
 * import { createMcpServer } from "@kova-sdk/wallet/adapters";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 * const wallet = new AgentWallet({ ... });
 * const server = createMcpServer(wallet);
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createMcpServer(
  wallet: AgentWalletLike,
  options?: McpServerOptions,
): Server {
  const server = new Server(
    {
      name: options?.serverInfo?.name ?? "kova-wallet",
      version: options?.serverInfo?.version ?? "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const tools = getFilteredTools({
    includeDangerous: options?.includeDangerous,
    exclude: options?.exclude,
  });

  // Concurrency limiter — shared across all tool calls on this server.
  // Counter is incremented BEFORE the check to prevent the TOCTOU race
  // where two concurrent calls both see the count below the limit.
  let pending = 0;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object" as const,
        // Deep copy to prevent prototype pollution and mutations
        // leaking back into canonical tool definitions (MED-29).
        properties: structuredClone(tool.parameters.properties),
        required: [...tool.parameters.required],
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Concurrency check — increment first, then check (atomic pattern).
    const current = ++pending;
    if (current > MAX_CONCURRENT_CALLS) {
      pending--;
      const errorResponse = sanitizeToolResponse(name, {
        success: false,
        error: `Concurrency limit exceeded (${MAX_CONCURRENT_CALLS} concurrent calls). Try again later.`,
      });
      return {
        content: [{ type: "text" as const, text: errorResponse }],
        isError: true,
      };
    }

    try {
      // Resolve auth token per-call to support token rotation (M32).
      const authToken = options?.authTokenProvider?.() ?? options?.authToken;

      // Wrap in timeout to prevent indefinite hangs (A-11).
      let timeoutId: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        safeHandleToolCall(
          wallet,
          name,
          (args ?? {}) as Record<string, unknown>,
          authToken,
        ),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new Error(
                  `Tool call "${name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms`,
                ),
              ),
            TOOL_CALL_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timeoutId));

      const sanitized = sanitizeToolResponse(name, result);

      // Determine if the wallet reported a failure.
      const isError =
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        (result as Record<string, unknown>).success === false;

      return {
        content: [{ type: "text" as const, text: sanitized }],
        isError,
      };
    } catch {
      // Return generic error — do not leak internal details (A-12).
      const errorResponse = sanitizeToolResponse(name, {
        success: false,
        error: "An internal error occurred while processing the tool call.",
      });
      return {
        content: [{ type: "text" as const, text: errorResponse }],
        isError: true,
      };
    } finally {
      pending--;
    }
  });

  return server;
}

/**
 * Convenience function: create an MCP server and connect it to stdio transport.
 *
 * This is the quickest way to start a kova MCP server. The stdio transport
 * is dynamically imported to keep the main adapter import lightweight for
 * consumers using other transports.
 *
 * @param wallet - Wallet instance with handleToolCall method
 * @param options - Optional filtering, auth, and server info options
 * @returns The connected MCP Server instance
 *
 * @example
 * ```typescript
 * import { AgentWallet } from "@kova-sdk/wallet";
 * import { createMcpStdioServer } from "@kova-sdk/wallet/adapters";
 *
 * const wallet = new AgentWallet({ ... });
 * const server = await createMcpStdioServer(wallet);
 * // Server is now running and accepting tool calls via stdio
 * ```
 */
export async function createMcpStdioServer(
  wallet: AgentWalletLike,
  options?: McpServerOptions,
): Promise<Server> {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = createMcpServer(wallet, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
