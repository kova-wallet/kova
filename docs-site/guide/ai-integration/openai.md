# OpenAI Integration

This guide shows how to connect a kova wallet to OpenAI's GPT models using the function calling (tool use) API. The agent can autonomously manage transactions, check balances, and operate within policy constraints.

## Prerequisites

Install the OpenAI SDK alongside kova:

```bash
npm install openai kova
```

Set your API key as an environment variable:

```bash
export OPENAI_API_KEY=sk-...
```

## Tool Format

`wallet.toOpenAITools()` converts the 8 wallet tools into OpenAI's function calling format:

```typescript
interface OpenAITool {
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
```

Each tool is wrapped in a `{ type: "function", function: { ... } }` envelope, which is what the Chat Completions API expects.

```typescript
import { AgentWallet } from "kova";

const tools = wallet.toOpenAITools();

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

## Full Tool-Use Loop

The following example implements a complete OpenAI function calling loop. The model receives a user message, decides which tools to call, and the loop continues until the model produces a final text response.

```typescript
import OpenAI from "openai";
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
} from "kova";

// 1. Set up the wallet
const store = new MemoryStore();
const signer = new LocalSigner({ privateKey: process.env.WALLET_PRIVATE_KEY! });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  }),
  new RateLimitRule({
    maxTransactionsPerMinute: 5,
    maxTransactionsPerHour: 20,
  }),
];
const engine = new PolicyEngine(rules, store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// 2. Create the OpenAI client and get tools
const openai = new OpenAI();
const tools = wallet.toOpenAITools();

// 3. Define the agent loop
async function runAgent(userMessage: string): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful payment assistant with access to a crypto wallet. Check your policy and balance before making transactions.",
    },
    { role: "user", content: userMessage },
  ];

  // 4. Send the initial chat completion with tools
  let response = await openai.chat.completions.create({
    model: "gpt-4o",
    tools,
    messages,
  });

  let choice = response.choices[0]!;

  // 5. Loop while the model wants to call tools
  while (choice.finish_reason === "tool_calls") {
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // 6. Parse tool_calls from the response
    const toolCalls = assistantMessage.tool_calls ?? [];

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      // 7. Call wallet.handleToolCall() for each tool call
      const result = await wallet.handleToolCall(functionName, functionArgs);

      // 8. Feed the result back as a tool message
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // 9. Send the next completion request
    response = await openai.chat.completions.create({
      model: "gpt-4o",
      tools,
      messages,
    });
    choice = response.choices[0]!;
  }

  // 10. Return the final text response
  return choice.message.content ?? "No response generated.";
}

// Usage
const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

## Handling Parallel Tool Calls

OpenAI models can request **multiple tool calls in a single response**. For example, the model might call `wallet_get_balance` and `wallet_get_policy` simultaneously to gather information before making a decision.

The loop above already handles this correctly because it iterates over all `tool_calls` in the response. However, you can also process them in parallel for better performance:

```typescript
async function processToolCallsInParallel(
  wallet: AgentWallet,
  toolCalls: OpenAI.ChatCompletionMessageToolCall[],
): Promise<OpenAI.ChatCompletionToolMessageParam[]> {
  // Execute all tool calls concurrently
  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);
      const result = await wallet.handleToolCall(functionName, functionArgs);

      return {
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
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
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools,
  messages,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "transaction_report",
      schema: {
        type: "object",
        properties: {
          action: { type: "string" },
          status: { type: "string", enum: ["success", "denied", "failed"] },
          txId: { type: "string" },
          summary: { type: "string" },
        },
        required: ["action", "status", "summary"],
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
async function safeRunAgent(userMessage: string): Promise<string> {
  try {
    return await runAgent(userMessage);
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error("OpenAI API error:", error.status, error.message);
      return "I'm having trouble connecting to the AI service. Please try again.";
    }
    console.error("Unexpected error:", error);
    return "An unexpected error occurred. Please try again.";
  }
}
```

Note that `wallet.handleToolCall()` never throws -- it always returns a `ToolCallResult` with `success: false` and an `error` message. The `try/catch` above is for OpenAI API failures (rate limits, network errors, etc.), not wallet errors.
