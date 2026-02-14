/**
 * OpenAI adapter — converts wallet tools to OpenAI function calling format.
 *
 * OpenAI's chat completions API expects:
 * { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }
 *
 * HIGH-16: Before dispatching tool calls, callers should use validateToolInput()
 * from "./tools.js" to validate and sanitize inputs. This ensures required fields
 * are present, types are correct, and unknown properties are stripped.
 */

import { getFilteredTools } from "./tools.js";

/** OpenAI tool shape as expected by the Chat Completions API */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Convert canonical wallet tool definitions to OpenAI's function calling format.
 * Wraps each tool in { type: "function", function: { ... } }.
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
export function toOpenAITools(options?: { includeDangerous?: boolean; exclude?: string[] }): OpenAITool[] {
  return getFilteredTools(options).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type,
        // MED-29: Use structuredClone for deep copy to prevent prototype pollution
        // and mutations from leaking back into the canonical tool definitions.
        properties: structuredClone(tool.parameters.properties),
        required: [...tool.parameters.required],
      },
    },
  }));
}
