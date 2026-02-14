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

import { getFilteredTools } from "./tools.js";

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
