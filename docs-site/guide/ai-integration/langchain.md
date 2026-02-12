# LangChain Integration

This guide shows how to use kova with LangChain to build tool-calling agents. The `createLangChainTools()` function generates tool definitions that integrate naturally with LangChain's agent framework.

## Prerequisites

Install LangChain packages alongside kova:

```bash
npm install @langchain/core @langchain/openai kova
```

You will also need an LLM provider API key (e.g., OpenAI):

```bash
export OPENAI_API_KEY=sk-...
```

## Creating Tools with `createLangChainTools()`

The `createLangChainTools(wallet)` function takes an `AgentWallet` instance and returns an array of tool definitions, each with a `call` method that delegates to `wallet.handleToolCall()`:

```typescript
import { createLangChainTools } from "kova";

const walletTools = createLangChainTools(wallet);

console.log(walletTools.length); // 8

console.log(walletTools[0]);
// {
//   name: "wallet_transfer",
//   description: "Transfer tokens to a recipient address. ...",
//   schema: {
//     type: "object",
//     properties: { to: { ... }, amount: { ... }, token: { ... }, chain: { ... } },
//     required: ["to", "amount", "token", "chain"]
//   },
//   call: [AsyncFunction]
// }
```

Each tool's `call` method accepts a `Record<string, unknown>` input and returns a JSON string (as LangChain expects string outputs from tools):

```typescript
const balanceTool = walletTools.find((t) => t.name === "wallet_get_balance")!;
const result = await balanceTool.call({ token: "SOL" });
console.log(result);
// '{"success":true,"data":{"token":"SOL","amount":"12.5","decimals":9}}'
```

::: tip
The `call` method internally invokes `wallet.handleToolCall(name, input)` and `JSON.stringify`s the `ToolCallResult`. Errors are caught and returned as `{ success: false, error: "..." }` -- the `call` method never throws.
:::

## Creating DynamicStructuredTool Instances

To use the wallet tools with LangChain agents, wrap them in `DynamicStructuredTool` instances. Since kova intentionally does not depend on LangChain or Zod, you create the bridge in your application code:

```typescript
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  createLangChainTools,
} from "kova";

// Set up the wallet
const store = new MemoryStore();
const signer = new LocalSigner({ privateKey: process.env.WALLET_PRIVATE_KEY! });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  }),
];
const engine = new PolicyEngine(rules, store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// Create LangChain-compatible tool definitions
const walletToolDefs = createLangChainTools(wallet);

// Wrap each tool definition as a DynamicStructuredTool
const langchainTools = walletToolDefs.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      // DynamicStructuredTool requires a Zod schema.
      // Use z.record() as a permissive schema since kova
      // handles its own validation inside handleToolCall().
      schema: z.record(z.unknown()),
      func: async (input) => t.call(input),
    }),
);
```

::: warning
The example above uses `z.record(z.unknown())` as the schema for simplicity. If you want LangChain to validate inputs before they reach the wallet, you can define explicit Zod schemas per tool. However, kova already validates all inputs inside `handleToolCall()`, so the permissive schema is safe to use.
:::

## Using with a Tool-Calling Agent

LangChain provides `createToolCallingAgent` to build agents that use LLM tool calling natively. Here is a complete example:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  AllowlistRule,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  createLangChainTools,
} from "kova";

// --- Wallet setup (same as above) ---
const store = new MemoryStore();
const signer = new LocalSigner({ privateKey: process.env.WALLET_PRIVATE_KEY! });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  }),
  new AllowlistRule({
    allowAddresses: ["9aE4Uy6gzM...", "7bF5Vz8hkN..."],
  }),
];
const engine = new PolicyEngine(rules, store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// --- LangChain agent setup ---
const walletToolDefs = createLangChainTools(wallet);
const langchainTools = walletToolDefs.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: z.record(z.unknown()),
      func: async (input) => t.call(input),
    }),
);

const llm = new ChatOpenAI({
  model: "gpt-4o",
  temperature: 0,
});

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a crypto payment assistant. Always check wallet_get_policy and wallet_get_balance before making any transfer. Explain any policy denials clearly.",
  ],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent = createToolCallingAgent({
  llm,
  tools: langchainTools,
  prompt,
});

const executor = new AgentExecutor({
  agent,
  tools: langchainTools,
  verbose: true, // Set to false in production
});

// --- Run the agent ---
async function runAgent(input: string): Promise<string> {
  const result = await executor.invoke({ input });
  return result.output;
}

const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

When `verbose: true`, the `AgentExecutor` logs each step, showing which tools the agent called and what results it received:

```
> Entering new AgentExecutor chain...
Invoking: wallet_get_policy
{"success":true,"data":{"name":"spending-limit+allowlist",...}}
Invoking: wallet_get_balance with {"token":"SOL"}
{"success":true,"data":{"token":"SOL","amount":"12.5","decimals":9}}
Invoking: wallet_transfer with {"to":"9aE4Uy6gzM...","amount":"2","token":"SOL","chain":"solana","reason":"User-requested payment"}
{"success":true,"data":{"status":"confirmed","txId":"5UBe...","summary":"Sent 2 SOL to 9aE4...gzM",...}}
> Finished chain.
```

## Using with Anthropic via LangChain

You can use the same tool setup with `ChatAnthropic` instead of `ChatOpenAI`:

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const llm = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0,
});

// The rest of the code is identical -- createToolCallingAgent,
// AgentExecutor, and the wallet tools work the same way.
```

::: tip
When using LangChain, you do **not** need `wallet.toAnthropicTools()` or `wallet.toOpenAITools()`. The `createLangChainTools()` function provides a unified interface that works with any LangChain-compatible LLM.
:::

## Streaming

For streaming responses, use `executor.stream()` instead of `executor.invoke()`:

```typescript
const stream = await executor.stream({ input: "Check my SOL balance" });

for await (const chunk of stream) {
  if (chunk.output) {
    process.stdout.write(chunk.output);
  }
}
```

## Custom Tool Subsets

If you want to expose only a subset of wallet tools to the agent (for example, read-only tools), filter the array before wrapping:

```typescript
const readOnlyTools = createLangChainTools(wallet).filter((t) =>
  ["wallet_get_balance", "wallet_get_policy", "wallet_get_transaction_history"].includes(t.name),
);

const langchainReadOnlyTools = readOnlyTools.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: z.record(z.unknown()),
      func: async (input) => t.call(input),
    }),
);
```

This is useful for monitoring agents that should observe the wallet without being able to execute transactions.
