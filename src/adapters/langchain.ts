/**
 * LangChain adapter — wraps wallet as LangChain-compatible tools.
 *
 * IMPORTANT: Does NOT import or depend on LangChain or Zod.
 * Produces plain objects with the right shape that can be used with LangChain's
 * DynamicStructuredTool or passed to custom tool construction.
 */

import { WALLET_TOOLS } from "./tools.js";
import type { ToolDefinition } from "./types.js";
import type { AgentWallet } from "../core/wallet.js";

/** Shape compatible with LangChain's tool interface */
export interface LangChainToolDefinition {
  name: string;
  description: string;
  schema: ToolDefinition["parameters"];
  call: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * Create LangChain-compatible tool definitions from a wallet instance.
 *
 * Each tool has a `call` method that delegates to wallet.handleToolCall()
 * and returns a JSON string (as LangChain expects string outputs from tools).
 *
 * Usage with LangChain's DynamicStructuredTool:
 * ```typescript
 * import { DynamicStructuredTool } from "@langchain/core/tools";
 *
 * const walletTools = createLangChainTools(wallet);
 * const langchainTools = walletTools.map(t =>
 *   new DynamicStructuredTool({
 *     name: t.name,
 *     description: t.description,
 *     func: async (input) => t.call(input),
 *   })
 * );
 * ```
 */
export function createLangChainTools(
  wallet: AgentWallet,
): LangChainToolDefinition[] {
  return WALLET_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: {
      type: tool.parameters.type,
      properties: { ...tool.parameters.properties },
      required: [...tool.parameters.required],
    },
    call: async (input: Record<string, unknown>): Promise<string> => {
      // S5-10 fix: defensive try/catch to prevent unhandled errors (e.g. BigInt serialization)
      try {
        const result = await wallet.handleToolCall(tool.name, input);
        return JSON.stringify(result);
      } catch {
        return JSON.stringify({
          success: false,
          error: "An internal error occurred while processing the tool call.",
        });
      }
    },
  }));
}
