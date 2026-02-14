/**
 * Types for AI agent tool definitions.
 * Compatible with Anthropic, OpenAI, and LangChain tool formats.
 */

/** Describes a single parameter in a wallet tool definition. */
export interface ToolParameter {
  /** LOW-17: Constrained to JSON Schema primitive types to prevent arbitrary type injection. */
  type: "string" | "number" | "boolean" | "integer" | "object" | "array";
  description: string;
  enum?: string[];
  /** Optional maximum constraint (e.g., for numeric limits). */
  maximum?: number;
  /** HIGH-T3-04 fix: Maximum string length for input validation. */
  maxLength?: number;
  /** HIGH-T3-04 fix: Maximum array length (for array-typed fields passed as JSON strings). */
  maxItems?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
