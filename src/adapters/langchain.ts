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

import { getFilteredTools, safeHandleToolCall, sanitizeToolResponse, TOOL_CALL_TIMEOUT_MS } from "./tools.js";
import type { ToolDefinition } from "./types.js";
import type { AgentWallet } from "../core/wallet.js";

/**
 * A-16: Maximum number of concurrent tool calls per createLangChainTools instance.
 * Prevents a runaway agent from overwhelming the wallet with parallel requests.
 */
const MAX_CONCURRENT_CALLS = 10;

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
  options?: { includeDangerous?: boolean; exclude?: string[]; authToken?: string },
): LangChainToolDefinition[] {
  // A-16 / M31: Atomic concurrency limiter — shared across all tools from this invocation.
  // The counter is incremented BEFORE the check to prevent the TOCTOU race condition
  // where two concurrent calls both see the count below the limit and both proceed.
  let pending = 0;
  const maxConcurrent = MAX_CONCURRENT_CALLS;

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
      // M31: Atomic concurrency check — increment first, then check.
      // This prevents the TOCTOU race where two calls both read the old value.
      const current = ++pending;
      if (current > maxConcurrent) {
        pending--;
        return sanitizeToolResponse(tool.name, {
          success: false,
          error: `Concurrency limit exceeded (${maxConcurrent} concurrent calls). Try again later.`,
        });
      }
      // S5-10 fix: defensive try/catch to prevent unhandled errors (e.g. BigInt serialization)
      try {
        // MED-28: Wrap handleToolCall in a timeout to prevent indefinite hangs.
        // If the call does not resolve within TOOL_CALL_TIMEOUT_MS, reject with a timeout error.
        // API-015: Ensure the timeout timer is cleaned up to prevent resource leaks
        // and unresolvable Promise references when the tool call resolves before the timeout.
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          safeHandleToolCall(wallet, tool.name, input, options?.authToken),
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
      } finally {
        // A-16: Always decrement concurrency counter
        pending--;
      }
    },
  }));
}
