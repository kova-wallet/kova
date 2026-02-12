/**
 * Types for AI agent tool definitions.
 * Compatible with Anthropic, OpenAI, and LangChain tool formats.
 */

/** Describes a single parameter in a wallet tool definition. */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
