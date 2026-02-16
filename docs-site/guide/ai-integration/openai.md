# OpenAI Integration

::: info What you'll learn
- How to connect a kova wallet to OpenAI's GPT models using `toOpenAITools()`
- How to implement the function calling loop that processes GPT's `tool_calls` and `finish_reason`
- How to handle parallel tool calls for better performance
- How to use structured outputs (`response_format`) for programmatic responses
- How to handle errors from both the OpenAI API and the wallet
- Key differences from the Claude integration (JSON string arguments, `role: "tool"` messages)
:::

This guide shows how to connect a kova wallet to OpenAI's GPT models using the function calling (tool use) API. The agent can autonomously manage transactions, check balances, and operate within policy constraints.

## Prerequisites

- **An OpenAI API key** -- get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **A working kova wallet** -- see [Your First Agent Wallet](/tutorials/first-wallet) if you have not set one up
- **Familiarity with async/await in TypeScript** -- the tool-use loop is asynchronous
- **The AI Integration Overview** -- read [the overview](./overview.md) first for the general concepts

Install the OpenAI SDK alongside kova:

```bash
# Install the OpenAI TypeScript SDK and the kova wallet SDK.
# openai provides the GPT API client for chat completions and function calling.
# kova provides the wallet, policy engine, and AI tool definitions.
npm install openai kova
```

Set your API key as an environment variable:

```bash
# Set the OpenAI API key as an environment variable.
# The OpenAI SDK automatically reads this variable -- you do not need to pass it explicitly.
# Get your API key from https://platform.openai.com/api-keys
export OPENAI_API_KEY=sk-...
```

## Tool Format

`wallet.toOpenAITools()` converts the wallet tools (6 safe by default) into OpenAI's function calling format:

```typescript
// The OpenAI tool format for function calling.
// Each tool is wrapped in a { type: "function", function: { ... } } envelope,
// which is what the Chat Completions API expects in the "tools" parameter.
interface OpenAITool {
  type: "function";          // Always "function" -- OpenAI uses this to identify tool type
  function: {
    name: string;            // Tool name (e.g., "wallet_transfer")
    description: string;     // Description sent to the model to guide usage
    parameters: {            // JSON Schema for the function's input parameters
      type: "object";
      properties: Record<string, unknown>; // Schema for each parameter
      required: string[];                  // Which parameters are mandatory
    };
  };
}
```

Each tool is wrapped in a `{ type: "function", function: { ... } }` envelope, which is what the Chat Completions API expects.

```typescript
// Import AgentWallet to access the toOpenAITools() conversion method.
import { AgentWallet } from "kova";

// Convert kova's canonical tool definitions into OpenAI's function calling format.
// This wraps each tool in the { type: "function", function: { ... } } envelope.
const tools = wallet.toOpenAITools();

// Inspect the first tool (wallet_transfer) to see the OpenAI format.
console.log(tools[0]);
// {
//   type: "function",
//   function: {
//     name: "wallet_transfer",
//     description: "Transfer tokens to a recipient address. ...",
//     parameters: {
//       type: "object",
//       properties: {
//         to: { type: "string", description: "Recipient wallet address" },
//         amount: { type: "string", description: "Amount to send ..." },
//         token: { type: "string", description: "Token symbol ..." },
//         chain: { type: "string", description: "Target blockchain", enum: ["solana", "ethereum", "base"] },
//         reason: { type: "string", description: "Why this transfer is being made ..." }
//       },
//       required: ["to", "amount", "token", "chain"]
//     }
//   }
// }
```

## What GPT Sees

Here is the actual JSON that flows between your server and OpenAI's API during a wallet interaction.

**Your server sends to OpenAI API:**

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a helpful payment assistant..." },
    { "role": "user", "content": "What is my SOL balance?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "wallet_get_balance",
        "description": "Check the wallet's balance for a specific token...",
        "parameters": {
          "type": "object",
          "properties": {
            "token": { "type": "string", "description": "Token symbol or mint address" }
          },
          "required": ["token"]
        }
      }
    }
  ]
}
```

**GPT responds with a tool call:**

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "wallet_get_balance",
          "arguments": "{\"token\": \"SOL\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

Notice that OpenAI sends function arguments as a **JSON string** (not a parsed object). You must call `JSON.parse(toolCall.function.arguments)` to get the actual parameters. This is different from Claude, where `block.input` is already a parsed object.

**Your server sends the tool result back:**

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"success\":true,\"data\":{\"token\":\"SOL\",\"amount\":\"12.5\",\"decimals\":9}}"
}
```

**GPT generates its final response:**

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Your current SOL balance is 12.5 SOL."
    },
    "finish_reason": "stop"
  }]
}
```

The key difference from Claude: OpenAI uses `finish_reason: "tool_calls"` (vs. `stop_reason: "tool_use"`), wraps tools in `{ type: "function", function: {...} }`, and sends arguments as a JSON string.

## Full Tool-Use Loop

The following example implements a complete OpenAI function calling loop. The model receives a user message, decides which tools to call, and the loop continues until the model produces a final text response.

```typescript
// Import the OpenAI SDK for communicating with GPT models.
import OpenAI from "openai";
// Import all the kova components needed to set up a wallet.
import {
  AgentWallet,       // The main wallet class that handles tool calls
  PolicyEngine,      // Evaluates policy rules against transaction intents
  SpendingLimitRule,  // Caps how much the agent can spend per transaction and per day
  RateLimitRule,     // Limits how many transactions can be executed per time window
  MemoryStore,       // In-memory persistence for development
  LocalSigner,       // In-memory signer for development (not for production)
  SolanaAdapter,     // Solana blockchain adapter
} from "kova";

// 1. Set up the wallet with policy rules that constrain what the GPT agent can do.
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
// Create a signer from a Keypair. In production, use MpcSigner with a hardware-backed provider.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
// Connect to the Solana RPC endpoint specified in the environment.
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Define the policy rules -- these are the hard limits the model cannot bypass.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" }, // Max 10 SOL per transaction
    daily: { amount: "50", token: "SOL" },          // Max 50 SOL per day total
  }),
  new RateLimitRule({
    maxTransactionsPerMinute: 5,  // No more than 5 transactions per minute
    maxTransactionsPerHour: 20,   // No more than 20 transactions per hour
  }),
];
// Create the policy engine with the rules and the shared store.
const engine = new PolicyEngine(rules, store);

// Assemble the AgentWallet with all components.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// 2. Create the OpenAI client (reads OPENAI_API_KEY from environment).
const openai = new OpenAI();
// Convert the wallet tools (6 safe by default) to OpenAI's function calling format.
const tools = wallet.toOpenAITools();

// 3. Define the agent loop -- this is the core of the OpenAI integration.
// It sends messages to GPT, processes function calls, and loops until
// the model produces a final text response (no more tool calls).
async function runAgent(userMessage: string): Promise<string> {
  // Initialize the conversation with a system message and the user's request.
  // The system message guides the model's behavior (not a security boundary).
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful payment assistant with access to a crypto wallet. Check your policy and balance before making transactions.",
    },
    { role: "user", content: userMessage },
  ];

  // 4. Send the initial chat completion with the wallet tools available.
  let response = await openai.chat.completions.create({
    model: "gpt-4o",   // The GPT model to use (supports function calling)
    tools,              // The wallet tools in OpenAI format
    messages,           // The conversation history
  });

  // Get the first (and usually only) choice from the response.
  let choice = response.choices[0]!;

  // 5. Loop while the model wants to call tools.
  // When finish_reason is "tool_calls", the model has returned one or more
  // function calls instead of a final text response.
  while (choice.finish_reason === "tool_calls") {
    // Save the assistant's message (containing tool_calls) to the conversation history.
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // 6. Parse the tool_calls array from the response.
    // OpenAI models can request multiple tool calls in a single response.
    const toolCalls = assistantMessage.tool_calls ?? [];

    for (const toolCall of toolCalls) {
      // Extract the function name and arguments from the tool call.
      // The arguments come as a JSON string that needs to be parsed.
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      // 7. Dispatch the tool call to the kova wallet.
      // This handles the full pipeline: validation, policy, build, sign, broadcast.
      const result = await wallet.handleToolCall(functionName, functionArgs);

      // 8. Feed the result back as a "tool" message.
      // OpenAI requires tool results to be sent as role: "tool" messages,
      // with tool_call_id matching the original tool call's id.
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,         // Must match the tool_call's id
        content: JSON.stringify(result),    // Serialize the ToolCallResult as JSON
      });
    }

    // 9. Send the next completion request with the updated conversation
    // (including tool results). The model will either call more tools
    // or generate a final text response.
    response = await openai.chat.completions.create({
      model: "gpt-4o",
      tools,
      messages,
    });
    choice = response.choices[0]!;
  }

  // 10. Return the final text response from the model.
  // When finish_reason is "stop" (not "tool_calls"), the model has
  // generated its final answer for the user.
  return choice.message.content ?? "No response generated.";
}

// Usage: send a natural-language request and get the model's response.
const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

## Handling Parallel Tool Calls

OpenAI models can request **multiple tool calls in a single response**. For example, the model might call `wallet_get_balance` and `wallet_get_policy` simultaneously to gather information before making a decision.

The loop above already handles this correctly because it iterates over all `tool_calls` in the response. However, you can also process them in parallel for better performance:

```typescript
// Process multiple tool calls concurrently using Promise.all.
// This is faster than sequential execution when the model requests
// multiple read operations (e.g., check balance AND check policy).
async function processToolCallsInParallel(
  wallet: AgentWallet,
  toolCalls: OpenAI.ChatCompletionMessageToolCall[],
): Promise<OpenAI.ChatCompletionToolMessageParam[]> {
  // Execute all tool calls concurrently using Promise.all.
  // Each tool call is dispatched to wallet.handleToolCall() in parallel.
  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // Extract function name and parse the JSON arguments string.
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);
      // Dispatch to the kova wallet.
      const result = await wallet.handleToolCall(functionName, functionArgs);

      // Return the result formatted as an OpenAI tool message.
      return {
        role: "tool" as const,               // OpenAI's role type for tool results
        tool_call_id: toolCall.id,           // Link back to the original tool call
        content: JSON.stringify(result),      // Serialized ToolCallResult
      };
    }),
  );

  return results;
}
```

::: warning
Be careful with parallel execution of **write operations**. If the model calls `wallet_transfer` twice in one turn, both calls go through the policy engine. The wallet serializes `execute()` calls internally to prevent race conditions, but the second transfer will block until the first completes. Read operations (`wallet_get_balance`, `wallet_get_policy`, `wallet_get_transaction_history`) are safe to parallelize.
:::

## Structured Outputs

If you want the model to respond in a structured format after using tools, you can combine function calling with OpenAI's `response_format` parameter:

```typescript
// Use OpenAI's structured output feature to get the model's final
// response in a predictable JSON format. This is useful when you need
// to parse the model's response programmatically (e.g., in a dashboard).
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools,
  messages,
  // response_format constrains the model's final text output to match a JSON schema.
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "transaction_report",  // A name for this response schema
      schema: {
        type: "object",
        properties: {
          action: { type: "string" },      // What the agent did (e.g., "transfer")
          status: { type: "string", enum: ["success", "denied", "failed"] }, // Outcome
          txId: { type: "string" },        // Transaction ID (if successful)
          summary: { type: "string" },     // Human-readable summary
        },
        required: ["action", "status", "summary"], // txId is optional (not present when denied)
      },
    },
  },
});
```

::: tip
`response_format` only applies to the **final text response**, not to intermediate tool-calling turns. The model will still call tools normally during the loop and only format its final answer as structured JSON.
:::

## Error Handling

Wrap the entire agent loop in error handling to catch both API errors and wallet errors:

```typescript
// A wrapper function that catches errors from both the OpenAI API
// and any unexpected failures in the agent loop.
async function safeRunAgent(userMessage: string): Promise<string> {
  try {
    // Run the agent loop (defined above).
    return await runAgent(userMessage);
  } catch (error) {
    // Handle OpenAI API-specific errors (rate limits, auth failures, network issues).
    if (error instanceof OpenAI.APIError) {
      console.error("OpenAI API error:", error.status, error.message);
      return "I'm having trouble connecting to the AI service. Please try again.";
    }
    // Handle any other unexpected errors.
    console.error("Unexpected error:", error);
    return "An unexpected error occurred. Please try again.";
  }
}
```

Note that `wallet.handleToolCall()` never throws -- it always returns a `ToolCallResult` with `success: false` and an `error` message. The `try/catch` above is for OpenAI API failures (rate limits, network errors, etc.), not wallet errors.

## Common Mistakes

1. **Forgetting to `JSON.parse` the function arguments.** OpenAI sends function arguments as a JSON *string*, not a parsed object. If you pass the raw string to `wallet.handleToolCall()`, it will fail because it expects an object. Always use `JSON.parse(toolCall.function.arguments)`.

2. **Checking `finish_reason === "function_call"` instead of `"tool_calls"`.** The older OpenAI function calling API used `"function_call"` as the finish reason. The current tools API uses `"tool_calls"`. Make sure you are checking for the correct string.

3. **Not including the system prompt in the messages array.** Unlike Claude (which uses a separate `system` parameter), OpenAI expects the system prompt as the first message with `role: "system"`. If you omit it, the model will not have guidance on how to use the wallet tools responsibly.

## Troubleshooting

### GPT not calling tools

- **Check the system prompt:** Add explicit instructions like "Use the available wallet tools to check balances and execute transfers."
- **Check tool schemas:** Log `wallet.toOpenAITools()` to verify the schemas are well-formed. Each tool must be wrapped in `{ type: "function", function: {...} }`.
- **Try a different model:** Make sure you are using a model that supports function calling (e.g., `gpt-4o`, `gpt-4-turbo`). Older models may not support the tools API.

### "Invalid function call" errors from OpenAI

- The model may generate malformed JSON in the `arguments` field. Wrap `JSON.parse(toolCall.function.arguments)` in a try/catch to handle this gracefully and return an error to the model.
- If this happens frequently, try adding more detailed parameter descriptions in your tool schemas.

### Parallel tool calls causing issues

- If the model calls `wallet_transfer` twice in parallel, both calls go through the policy engine. The wallet serializes write operations internally, so the second call will block until the first completes. This is safe but may cause unexpected timeouts with very short timeout settings.
- Read operations (`wallet_get_balance`, `wallet_get_policy`, `wallet_get_transaction_history`) are fully safe to parallelize.

## What to Try Next

- **Use structured outputs** to get GPT's final response as a structured JSON object (transaction report) instead of free-form text. The `response_format` example above shows how.
- **Build a conversational payment agent** that maintains state across multiple user messages. Store the `messages` array in a database or session and append new messages to continue the conversation.
- **Compare Claude vs. GPT** by running the same wallet setup with both providers and comparing their tool-calling behavior. You may find that one model is more conservative or verbose than the other.

## Next Steps

- [Claude Integration](./claude.md) -- The same pattern with Anthropic's Claude
- [LangChain Integration](./langchain.md) -- Agent executor with automatic tool dispatch
- [Server Setup](/guide/server-setup) -- Run the integration as an HTTP API
