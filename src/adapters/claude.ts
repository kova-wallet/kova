/**
 * Claude (Anthropic) adapter — converts wallet tools to Anthropic tool format.
 *
 * Anthropic's messages API expects:
 * { name, description, input_schema: { type: "object", properties, required } }
 *
 * HIGH-16: Before dispatching tool calls, callers should use validateToolInput()
 * from "./tools.js" to validate and sanitize inputs. This ensures required fields
 * are present, types are correct, and unknown properties are stripped.
 */

import { getFilteredTools, safeHandleToolCall, sanitizeToolResponse, TOOL_CALL_TIMEOUT_MS } from "./tools.js";

/**
 * A-03: Minimal wallet interface for adapter usage.
 * Avoids coupling to the full AgentWallet class.
 */
interface AgentWalletLike {
  handleToolCall: (name: string, input: Record<string, unknown>, authToken?: string) => Promise<unknown>;
}

/** Anthropic tool shape as expected by the Messages API */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Convert canonical wallet tool definitions to Anthropic's tool format.
 * The only difference is the key name: `parameters` -> `input_schema`.
 *
 * @deprecated Use `createClaudeTools(wallet, options).definitions` instead.
 * This function returns raw tool definitions without the safety wrapper.
 *
 * @security Using this function directly bypasses auth, rate limiting, and input
 * sanitization enforced by `safeHandleToolCall()`. Consumers who use these raw
 * definitions must manually call `safeHandleToolCall()` and `sanitizeToolResponse()`
 * or risk exposing unprotected wallet operations.
 *
 * @warning Callers MUST use safeHandleToolCall() and sanitizeToolResponse() on results.
 * Prefer createClaudeTools() which handles this automatically.
 *
 * API-009: This adapter performs format conversion only and does not enforce execution
 * timeouts. Execution timeouts for tool calls should be handled at the application level
 * (e.g., in the agent loop or via safeHandleToolCall) rather than in adapter conversion
 * functions. See LangChain adapter for a reference timeout implementation.
 *
 * @param options - Optional filtering options. Pass { includeDangerous: true } to
 *   include wallet_execute_custom and wallet_get_policy. Pass { exclude: [...] }
 *   to remove specific tools by name.
 */
export function toAnthropicTools(options?: { includeDangerous?: boolean; exclude?: string[] }): AnthropicTool[] {
  return getFilteredTools(options).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: tool.parameters.type,
      // MED-29: Use structuredClone for deep copy to prevent prototype pollution
      // and mutations from leaking back into the canonical tool definitions.
      properties: structuredClone(tool.parameters.properties),
      required: [...tool.parameters.required],
    },
  }));
}

/**
 * A-03/A-11/A-12/A-14: Create Claude-compatible tools with safe execution wrapper.
 *
 * Returns tool definitions and a handleToolCall function that:
 * - Validates inputs via safeHandleToolCall (A-03)
 * - Sanitizes responses via sanitizeToolResponse (A-03)
 * - Enforces execution timeout via Promise.race (A-11)
 * - Catches errors and returns generic error messages (A-12)
 * - Forwards optional authToken for authentication (A-14)
 *
 * @param wallet - Wallet instance with handleToolCall method
 * @param options - Optional filtering and auth options
 */
export function createClaudeTools(
  wallet: AgentWalletLike,
  options?: {
    includeDangerous?: boolean;
    exclude?: string[];
    authToken?: string;
    /**
     * M32: Optional function that returns the current auth token on each call.
     * When set, this is called on every handleToolCall invocation to support
     * token rotation. Falls back to the static `authToken` if not provided.
     */
    authTokenProvider?: () => string | undefined;
  },
): {
  definitions: ReturnType<typeof toAnthropicTools>;
  handleToolCall: (name: string, input: Record<string, unknown>) => Promise<string>;
} {
  const definitions = toAnthropicTools(options);
  return {
    definitions,
    handleToolCall: async (name: string, input: Record<string, unknown>): Promise<string> => {
      // M32: Resolve auth token per-call to support token rotation
      const authToken = options?.authTokenProvider?.() ?? options?.authToken;
      try {
        // A-11: Wrap in timeout to prevent indefinite hangs
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          safeHandleToolCall(wallet, name, input, authToken),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`Tool call "${name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms`)),
              TOOL_CALL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timeoutId));
        return sanitizeToolResponse(name, result);
      } catch {
        // A-12: Return generic error message — do not leak internal details
        return sanitizeToolResponse(name, {
          success: false,
          error: "An internal error occurred while processing the tool call.",
        });
      }
    },
  };
}
