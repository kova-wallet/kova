# LangChain Integration

::: info What you'll learn
- How to use `createLangChainTools()` to generate LangChain-compatible tool definitions
- How to bridge kova tools into LangChain's `DynamicStructuredTool` format with Zod schemas
- How to create and run a `ToolCallingAgent` with the `AgentExecutor`
- How to switch between OpenAI and Anthropic models using the same tool setup
- How to stream responses and create read-only agent subsets
:::

This guide shows how to use kova with LangChain to build tool-calling agents. The `createLangChainTools()` function generates tool definitions that integrate naturally with LangChain's agent framework.

::: tip When to use LangChain vs. direct integration
If you are already using LangChain in your project, this integration lets you add wallet capabilities to your existing agents with minimal code. If you are building a new project from scratch and only need wallet tools, the direct [Claude](./claude.md) or [OpenAI](./openai.md) integrations have fewer dependencies and give you more control. LangChain adds an abstraction layer that is powerful but also adds complexity.
:::

## Prerequisites

- **An LLM provider API key** -- OpenAI (`OPENAI_API_KEY`) or Anthropic (`ANTHROPIC_API_KEY`)
- **A working kova wallet** -- see [Your First Agent Wallet](/tutorials/first-wallet) if you have not set one up
- **Familiarity with LangChain concepts** -- agents, tools, and prompt templates. If you are new to LangChain, their [quickstart guide](https://js.langchain.com/docs/get_started/quickstart) is a good starting point.

Install LangChain packages alongside kova:

```bash
# Install the LangChain core packages, the OpenAI LangChain adapter, and kova.
# @langchain/core provides the base tool and prompt abstractions.
# @langchain/openai provides the ChatOpenAI LLM wrapper for LangChain.
# kova provides the wallet, policy engine, and the createLangChainTools() function.
npm install @langchain/core @langchain/openai kova
```

You will also need an LLM provider API key (e.g., OpenAI):

```bash
# Set the OpenAI API key. LangChain's ChatOpenAI reads this automatically.
# You can also use ChatAnthropic with ANTHROPIC_API_KEY instead.
export OPENAI_API_KEY=sk-...
```

## Creating Tools with `createLangChainTools()`

The `createLangChainTools(wallet)` function takes an `AgentWallet` instance and returns an array of tool definitions, each with a `call` method that delegates to `wallet.handleToolCall()`:

```typescript
// Import the createLangChainTools function from kova.
// This converts the wallet tools (6 safe by default) into a format compatible with LangChain.
import { createLangChainTools } from "kova";

// Generate LangChain-compatible tool definitions from the wallet.
// Each tool has a name, description, schema, and a call() method.
const walletTools = createLangChainTools(wallet);

// 6 safe wallet tools are included by default (2 dangerous tools are opt-in).
console.log(walletTools.length); // 6

// Inspect the first tool to see the LangChain-compatible format.
// Note: LangChain uses "schema" instead of "parameters" or "input_schema".
console.log(walletTools[0]);
// {
//   name: "wallet_transfer",
//   description: "Transfer tokens to a recipient address. ...",
//   schema: {
//     type: "object",
//     properties: { to: { ... }, amount: { ... }, token: { ... }, chain: { ... } },
//     required: ["to", "amount", "token", "chain"]
//   },
//   call: [AsyncFunction]  -- delegates to wallet.handleToolCall()
// }
```

Each tool's `call` method accepts a `Record<string, unknown>` input and returns a JSON string (as LangChain expects string outputs from tools):

```typescript
// Find the wallet_get_balance tool from the array.
const balanceTool = walletTools.find((t) => t.name === "wallet_get_balance")!;

// Call the tool directly with the required parameters.
// The call() method invokes wallet.handleToolCall() internally,
// then JSON.stringifies the ToolCallResult for LangChain compatibility.
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
// Import LangChain's DynamicStructuredTool for wrapping kova tools.
import { DynamicStructuredTool } from "@langchain/core/tools";
// Import Zod for schema validation (required by DynamicStructuredTool).
import { z } from "zod";
// Import all the kova components needed.
import {
  AgentWallet,           // The main wallet class
  PolicyEngine,          // Evaluates policy rules against transaction intents
  SpendingLimitRule,     // Spending cap policy rule
  MemoryStore,           // In-memory persistence for development
  LocalSigner,           // In-memory signer for development
  SolanaAdapter,         // Solana blockchain adapter
  createLangChainTools,  // Converts wallet tools to LangChain format
} from "kova";

// Set up the wallet with a spending limit policy.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Define spending limits that the LangChain agent must respect.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" }, // Max 10 SOL per transaction
    daily: { amount: "50", token: "SOL" },          // Max 50 SOL per day
  }),
];
const engine = new PolicyEngine(rules, store);

// Assemble the AgentWallet.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// Create kova tool definitions in LangChain-compatible format.
const walletToolDefs = createLangChainTools(wallet);

// Bridge kova tools into LangChain by wrapping each one as a DynamicStructuredTool.
// DynamicStructuredTool is LangChain's way of defining tools with schema validation.
const langchainTools = walletToolDefs.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,                // Tool name (e.g., "wallet_transfer")
      description: t.description,  // Description sent to the LLM
      // DynamicStructuredTool requires a Zod schema for input validation.
      // We use z.record(z.unknown()) as a permissive schema because kova
      // already validates all inputs inside handleToolCall(). This avoids
      // duplicating validation logic and keeps the integration simple.
      schema: z.record(z.unknown()),
      // The func property is the function LangChain calls when the LLM invokes this tool.
      // It delegates to kova's call() method, which handles the full pipeline.
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
// Import the LangChain LLM wrapper for OpenAI's chat models.
import { ChatOpenAI } from "@langchain/openai";
// Import LangChain's agent creation and execution utilities.
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
// Import the prompt template for structuring the conversation.
import { ChatPromptTemplate } from "@langchain/core/prompts";
// Import DynamicStructuredTool for wrapping kova tools.
import { DynamicStructuredTool } from "@langchain/core/tools";
// Import Zod for schema definitions.
import { z } from "zod";
// Import all the kova components.
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

// --- Wallet setup ---
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Define policy rules: spending limits + address allowlist.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" }, // Max 10 SOL per transaction
    daily: { amount: "50", token: "SOL" },          // Max 50 SOL per day
  }),
  new AllowlistRule({
    // Only these addresses can receive transfers from this wallet.
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

// Generate kova tool definitions and wrap them as LangChain DynamicStructuredTools.
const walletToolDefs = createLangChainTools(wallet);
const langchainTools = walletToolDefs.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: z.record(z.unknown()), // Permissive schema; kova handles validation
      func: async (input) => t.call(input),
    }),
);

// Create a ChatOpenAI LLM instance with deterministic output (temperature: 0).
const llm = new ChatOpenAI({
  model: "gpt-4o",     // GPT-4o supports function calling
  temperature: 0,       // Deterministic output for consistent agent behavior
});

// Define the conversation prompt template.
// The system message instructs the agent to check policy and balance first.
// {input} is replaced with the user's message.
// {agent_scratchpad} is where LangChain inserts intermediate tool call results.
const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a crypto payment assistant. Always check wallet_get_policy and wallet_get_balance before making any transfer. Explain any policy denials clearly.",
  ],
  ["human", "{input}"],                 // The user's message
  ["placeholder", "{agent_scratchpad}"], // LangChain fills this with tool call history
]);

// Create a tool-calling agent that uses the LLM's native function calling capability.
// This agent will automatically call wallet tools when the LLM decides to.
const agent = createToolCallingAgent({
  llm,                    // The language model
  tools: langchainTools,  // The wrapped kova wallet tools
  prompt,                 // The conversation template
});

// Wrap the agent in an AgentExecutor, which manages the tool-calling loop.
// The executor handles sending messages, processing tool calls, and iterating
// until the LLM produces a final text response.
const executor = new AgentExecutor({
  agent,
  tools: langchainTools,
  verbose: true, // Set to false in production -- logs each step to the console
});

// --- Run the agent ---
// Send a natural-language request and get the agent's response.
async function runAgent(input: string): Promise<string> {
  // invoke() runs the full agent loop: LLM call -> tool calls -> LLM call -> ...
  // until the LLM produces a final text response.
  const result = await executor.invoke({ input });
  return result.output;
}

// Example: ask the agent to send SOL. It will check policy and balance first.
const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

### What the LangChain Agent Sees

When the agent runs, LangChain manages the tool-use loop for you. Here is a simplified view of the data flow:

```
User input: "Send 2 SOL to 9aE4Uy6gzM..."
        |
        v
LangChain sends to LLM:
  - System prompt (from ChatPromptTemplate)
  - User message
  - Tool schemas (from DynamicStructuredTool definitions)
        |
        v
LLM responds with tool calls:
  1. wallet_get_policy({})  -->  kova returns policy config
  2. wallet_get_balance({ token: "SOL" })  -->  kova returns balance
  3. wallet_transfer({ to: "9aE4...", amount: "2", token: "SOL", chain: "solana" })
     --> kova runs policy -> build -> sign -> broadcast -> returns result
        |
        v
LLM generates final text:
  "I've sent 2 SOL to 9aE4Uy6gzM... Transaction ID: 5UBe..."
```

The `AgentExecutor` handles the loop automatically -- you do not need to write the while loop yourself (unlike the direct Claude or OpenAI integrations). This is LangChain's main advantage: less boilerplate code.

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
// Import the LangChain Anthropic adapter instead of OpenAI.
// This uses Claude models for the agent's reasoning.
import { ChatAnthropic } from "@langchain/anthropic";

// Create a ChatAnthropic LLM instance.
// Requires ANTHROPIC_API_KEY to be set in the environment.
const llm = new ChatAnthropic({
  model: "claude-sonnet-4-5-20250929", // Claude model that supports tool calling
  temperature: 0,                    // Deterministic output
});

// The rest of the code is identical -- createToolCallingAgent,
// AgentExecutor, and the wallet tools work the same way.
// LangChain abstracts away the provider differences.
```

::: tip
When using LangChain, you do **not** need `wallet.toAnthropicTools()` or `wallet.toOpenAITools()`. The `createLangChainTools()` function provides a unified interface that works with any LangChain-compatible LLM.
:::

## Streaming

For streaming responses, use `executor.stream()` instead of `executor.invoke()`:

```typescript
// Use stream() for incremental output, useful for real-time UIs.
// The executor yields chunks as the LLM generates them, including
// intermediate tool call results and the final text response.
const stream = await executor.stream({ input: "Check my SOL balance" });

// Process each chunk as it arrives.
for await (const chunk of stream) {
  // chunk.output contains the text portion of the response.
  // Intermediate tool calls may also appear in the stream.
  if (chunk.output) {
    process.stdout.write(chunk.output);
  }
}
```

## Custom Tool Subsets

If you want to expose only a subset of wallet tools to the agent (for example, read-only tools), filter the array before wrapping:

```typescript
// Filter the kova tools to only include read-only operations.
// This prevents the agent from executing any write operations (transfers, swaps, etc.).
const readOnlyTools = createLangChainTools(wallet).filter((t) =>
  // Only keep the three read-only tools that do not modify on-chain state.
  ["wallet_get_balance", "wallet_get_policy", "wallet_get_transaction_history"].includes(t.name),
);

// Wrap the filtered tools as LangChain DynamicStructuredTools.
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

## Common Mistakes

1. **Importing from the wrong LangChain package.** LangChain has multiple packages (`@langchain/core`, `@langchain/openai`, `@langchain/anthropic`, `langchain`). Make sure you import `DynamicStructuredTool` from `@langchain/core/tools`, `ChatOpenAI` from `@langchain/openai`, and `createToolCallingAgent` / `AgentExecutor` from `langchain/agents`. Importing from the wrong package will cause "module not found" errors.

2. **Using `wallet.toOpenAITools()` or `wallet.toAnthropicTools()` with LangChain.** When using LangChain, always use `createLangChainTools(wallet)` -- it produces the format LangChain expects. The `toOpenAITools()` and `toAnthropicTools()` methods are for direct API integrations, not for LangChain. Using the wrong format will cause the `AgentExecutor` to fail silently.

3. **Forgetting to install Zod.** `DynamicStructuredTool` requires a Zod schema for input validation. If you get an error about `z is not defined`, make sure you have `zod` installed (`npm install zod`) and imported (`import { z } from "zod"`).

## Troubleshooting

### Agent loops forever without producing a result

- The `AgentExecutor` has a default maximum iteration limit (usually 15). If the agent keeps calling tools without reaching a final answer, it will eventually stop. You can control this with the `maxIterations` parameter: `new AgentExecutor({ agent, tools, maxIterations: 10 })`.
- Check the system prompt -- if it does not clearly tell the LLM when to stop, the agent may keep calling tools indefinitely.

### "Tool not found" errors

- Make sure the tool names in `createLangChainTools(wallet)` match what the LLM is trying to call. LangChain uses the `name` property from each `DynamicStructuredTool`.
- If you are filtering tools (custom subsets), verify the filter is not excluding tools the agent needs.

### Agent calls tools but result is always `{ success: false }`

- Check the wallet setup (signer, chain adapter, policy engine). The most common cause is a missing or invalid `SOLANA_RPC_URL` or `WALLET_PRIVATE_KEY`.
- Log the actual error message from the `ToolCallResult` to see what went wrong: the `error` field contains a sanitized but descriptive message.

### TypeScript errors about Zod types

- If you see type errors related to `z.record(z.unknown())`, make sure you are using a compatible version of Zod (v3.x). LangChain's `DynamicStructuredTool` expects Zod v3 schemas.

## What to Try Next

- **Build a multi-agent system.** Create two LangChain agents: a "monitor" agent with read-only tools that watches the wallet, and a "trader" agent with write tools that executes swaps. Have the monitor agent decide when conditions are right and trigger the trader agent.
- **Add memory to the agent.** Use LangChain's `BufferMemory` or `ConversationSummaryMemory` to give the agent context across multiple conversations. This lets the agent remember previous transactions and make smarter decisions.
- **Create custom tool schemas.** Replace the permissive `z.record(z.unknown())` with explicit Zod schemas for each tool (e.g., `z.object({ token: z.string().describe("Token symbol") })`) to get better type safety and LLM guidance.

## Next Steps

- [Claude Integration](./claude.md) -- Direct integration without LangChain
- [OpenAI Integration](./openai.md) -- Direct integration without LangChain
- [Server Setup](/guide/server-setup) -- Run the integration as an HTTP API
