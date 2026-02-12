/**
 * Claude (Anthropic) adapter — converts wallet tools to Anthropic tool format.
 *
 * Anthropic's messages API expects:
 * { name, description, input_schema: { type: "object", properties, required } }
 */

import { WALLET_TOOLS } from "./tools.js";

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
 * The only difference is the key name: `parameters` → `input_schema`.
 */
export function toAnthropicTools(): AnthropicTool[] {
  return WALLET_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: tool.parameters.type,
      properties: { ...tool.parameters.properties },
      required: [...tool.parameters.required],
    },
  }));
}
