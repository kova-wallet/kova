/**
 * LangChain adapter — wraps wallet as LangChain-compatible tools.
 *
 * IMPORTANT: Does NOT import or depend on LangChain or Zod.
 * Produces plain objects with the right shape that can be used with LangChain's
 * DynamicStructuredTool or passed to custom tool construction.
 *
 * HIGH-16: Before dispatching tool calls, callers should use validateToolInput()
 * from "./tools.js" to validate and sanitize inputs. This ensures required fields
 * are present, types are correct, and unknown properties are stripped.
 */

import { getFilteredTools, safeHandleToolCall, sanitizeToolResponse } from "./tools.js";
import type { ToolDefinition } from "./types.js";
import type { AgentWallet } from "../core/wallet.js";

/** MED-28: Timeout for tool call execution in milliseconds (120 seconds). */
const TOOL_CALL_TIMEOUT_MS = 120_000;

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
  options?: { includeDangerous?: boolean; exclude?: string[] },
): LangChainToolDefinition[] {
  return getFilteredTools(options).map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: {
      type: tool.parameters.type,
      // MED-29: Use structuredClone for deep copy to prevent prototype pollution
      // and mutations from leaking back into the canonical tool definitions.
      properties: structuredClone(tool.parameters.properties),
      required: [...tool.parameters.required],
    },
    call: async (input: Record<string, unknown>): Promise<string> => {
      // S5-10 fix: defensive try/catch to prevent unhandled errors (e.g. BigInt serialization)
      try {
        // MED-28: Wrap handleToolCall in a timeout to prevent indefinite hangs.
        // If the call does not resolve within TOOL_CALL_TIMEOUT_MS, reject with a timeout error.
        // API-015: Ensure the timeout timer is cleaned up to prevent resource leaks
        // and unresolvable Promise references when the tool call resolves before the timeout.
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          safeHandleToolCall(wallet, tool.name, input),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`Tool call "${tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms`)),
              TOOL_CALL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timeoutId));
        // CRIT-T3-01 fix: Sanitize tool response to mitigate indirect prompt injection.
        // Wraps data in structured delimiters, truncates long strings, and strips
        // characters commonly used in injection attacks from on-chain data.
        return sanitizeToolResponse(tool.name, result);
      } catch (err) {
        const message = "An internal error occurred while processing the tool call.";
        if (err instanceof Error && process.env.NODE_ENV === "test") {
          // Only expose details in test environment for debugging
          process.emitWarning(
            `Tool processing error in ${tool.name}`,
            { code: "KOVA_TOOL_ERROR" },
          );
        }
        return sanitizeToolResponse(tool.name, { success: false, error: message });
      }
    },
  }));
}
