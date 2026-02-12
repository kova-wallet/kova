/**
 * OpenAI adapter — converts wallet tools to OpenAI function calling format.
 *
 * OpenAI's chat completions API expects:
 * { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }
 */

import { WALLET_TOOLS } from "./tools.js";

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
 */
export function toOpenAITools(): OpenAITool[] {
  return WALLET_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type,
        properties: { ...tool.parameters.properties },
        required: [...tool.parameters.required],
      },
    },
  }));
}
