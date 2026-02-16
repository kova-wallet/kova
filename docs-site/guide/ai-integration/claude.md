# Claude (Anthropic) Integration

::: info What you'll learn
- How to connect a kova wallet to Anthropic's Claude using `toAnthropicTools()`
- How to implement the tool-use loop that processes Claude's `tool_use` / `tool_result` blocks
- How to build a multi-turn payment agent that checks policy and balance before transacting
- How to write effective system prompts that guide Claude's behavior (and why they are not a security boundary)
- The complete data flow between your server and Claude's API
:::

This guide shows how to connect a kova wallet to Anthropic's Claude model using the tool-use (function calling) API. Claude can autonomously check balances, review policy constraints, and execute transactions within the limits you define.

## Prerequisites

- **An Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/)
- **A working kova wallet** -- see [Your First Agent Wallet](/tutorials/first-wallet) if you have not set one up
- **Familiarity with async/await in TypeScript** -- the tool-use loop is asynchronous
- **The AI Integration Overview** -- read [the overview](./overview.md) first for the general concepts

Install the Anthropic SDK alongside kova:

```bash
# Install both the Anthropic TypeScript SDK and the kova wallet SDK.
# @anthropic-ai/sdk provides the Claude API client for sending messages and handling tool use.
# kova provides the wallet, policy engine, and AI tool definitions.
npm install @anthropic-ai/sdk kova
```

Set your API key as an environment variable:

```bash
# Set the Anthropic API key as an environment variable.
# The Anthropic SDK automatically reads this variable -- you do not need to pass it explicitly.
# Get your API key from https://console.anthropic.com/
export ANTHROPIC_API_KEY=sk-ant-...
```

## Tool Format

`wallet.toAnthropicTools()` converts the wallet tools (6 safe by default) into Anthropic's expected format:

```typescript
// The Anthropic tool format. This is what Claude's API expects when you
// provide tools for function calling / tool use.
interface AnthropicTool {
  name: string;            // Tool name (e.g., "wallet_transfer")
  description: string;     // Detailed description sent to Claude to guide usage
  input_schema: {          // JSON Schema describing the tool's input parameters.
                           // Note: Anthropic uses "input_schema" instead of "parameters".
    type: "object";
    properties: Record<string, unknown>; // Schema for each parameter
    required: string[];                  // Which parameters are mandatory
  };
}
```

The key difference from the canonical format is the property name: `parameters` becomes `input_schema`.

```typescript
// Import AgentWallet to access the toAnthropicTools() conversion method.
import { AgentWallet } from "kova";

// Convert kova's canonical tool definitions into Anthropic's format.
// This handles the parameters → input_schema rename automatically.
const tools = wallet.toAnthropicTools();

// Inspect the first tool (wallet_transfer) to see the Anthropic format.
console.log(tools[0]);
// {
//   name: "wallet_transfer",
//   description: "Transfer tokens to a recipient address. Sends a specified ...",
//   input_schema: {
//     type: "object",
//     properties: {
//       to: { type: "string", description: "Recipient wallet address" },
//       amount: { type: "string", description: "Amount to send as a decimal string ..." },
//       token: { type: "string", description: "Token symbol (e.g., \"SOL\", \"USDC\") ..." },
//       chain: { type: "string", description: "Target blockchain", enum: ["solana", "ethereum", "base"] },
//       reason: { type: "string", description: "Why this transfer is being made ..." }
//     },
//     required: ["to", "amount", "token", "chain"]
//   }
// }
```

## What Claude Sees

To understand the integration, it helps to see exactly what JSON gets sent to Claude's API and what comes back. Here is the actual data flow for a balance check.

**Your server sends to Claude API:**

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "system": "You are a helpful payment assistant with access to a crypto wallet.",
  "tools": [
    {
      "name": "wallet_get_balance",
      "description": "Check the wallet's balance for a specific token...",
      "input_schema": {
        "type": "object",
        "properties": {
          "token": { "type": "string", "description": "Token symbol or mint address" }
        },
        "required": ["token"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What is my SOL balance?" }
  ]
}
```

**Claude responds with a tool_use block:**

```json
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "wallet_get_balance",
      "input": { "token": "SOL" }
    }
  ],
  "stop_reason": "tool_use"
}
```

**Your server executes the tool call and sends the result back:**

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "{\"success\":true,\"data\":{\"token\":\"SOL\",\"amount\":\"12.5\",\"decimals\":9,\"usdValue\":2500.00}}"
    }
  ]
}
```

**Claude generates its final text response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Your current SOL balance is 12.5 SOL, worth approximately $2,500.00 USD."
    }
  ],
  "stop_reason": "end_turn"
}
```

Notice the key pattern: when `stop_reason` is `"tool_use"`, Claude wants to call a tool and you need to execute it. When `stop_reason` is `"end_turn"`, Claude has finished and produced its final text response. The tool-use loop below automates this cycle.

## Full Tool-Use Loop

The following example implements a complete Claude tool-use loop. Claude receives a user message, decides which wallet tools to call, and the loop continues until Claude produces a final text response.

```typescript
// Import the Anthropic SDK for communicating with Claude's API.
import Anthropic from "@anthropic-ai/sdk";
// Import all the kova components needed to set up a wallet.
import {
  AgentWallet,       // The main wallet class that handles tool calls
  PolicyEngine,      // Evaluates policy rules against transaction intents
  SpendingLimitRule,  // Caps how much the agent can spend per transaction and per day
  AllowlistRule,     // Restricts which addresses the agent can send to
  MemoryStore,       // In-memory persistence for development
  LocalSigner,       // In-memory signer for development (not for production)
  SolanaAdapter,     // Solana blockchain adapter
} from "kova";

// 1. Set up the wallet with policy rules that constrain what Claude can do.
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
// Create a signer from a Keypair. In production, use MpcSigner with a hardware-backed provider.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
// Connect to the Solana RPC endpoint specified in the environment.
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Define the policy rules. These are the hard limits that Claude cannot bypass,
// regardless of what the system prompt says or what the user asks for.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" }, // Max 10 SOL per transaction
    daily: { amount: "50", token: "SOL" },          // Max 50 SOL per day total
  }),
  new AllowlistRule({
    // Only these two addresses can receive transfers from this wallet.
    allowAddresses: ["9aE4Uy6gzM...", "7bF5Vz8hkN..."],
  }),
];
// Create the policy engine with rules and the shared store.
const engine = new PolicyEngine(rules, store);

// Assemble the AgentWallet with all components.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// 2. Create the Anthropic client (reads ANTHROPIC_API_KEY from environment).
const anthropic = new Anthropic();
// Convert the wallet tools (6 safe by default) to Anthropic's expected format.
const tools = wallet.toAnthropicTools();

// 3. Define the agent loop -- this is the core of the Claude integration.
// It sends messages to Claude, processes tool calls, and loops until
// Claude produces a final text response (no more tool calls).
async function runAgent(userMessage: string): Promise<string> {
  // Initialize the conversation with the user's message.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // 4. Send the initial message to Claude with the wallet tools available.
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",       // The Claude model to use
    max_tokens: 1024,                        // Maximum response length
    // System prompt guides Claude's behavior (but is NOT a security boundary).
    system: "You are a helpful payment assistant with access to a crypto wallet. Always check your policy constraints before making transactions.",
    tools,                                   // The wallet tools in Anthropic format
    messages,                                // The conversation history
  });

  // 5. Loop while Claude wants to call tools.
  // When stop_reason is "tool_use", Claude has returned one or more tool_use blocks
  // instead of (or in addition to) text. We need to execute those tools and
  // feed the results back for the next turn.
  while (response.stop_reason === "tool_use") {
    // Save Claude's response (which contains tool_use blocks) to the conversation history.
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // 6. Process each tool_use block in Claude's response.
    // Claude can call multiple tools in a single turn (e.g., check balance AND policy).
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Dispatch the tool call to the kova wallet.
        // block.name is the tool name (e.g., "wallet_transfer").
        // block.input is the JSON object Claude generated for the tool's parameters.
        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>,
        );
        // Package the result as an Anthropic tool_result block.
        // tool_use_id links this result back to the specific tool call.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,             // Must match the tool_use block's id
          content: JSON.stringify(result),    // Serialize the ToolCallResult as JSON
        });
      }
    }

    // 7. Push the tool results back as a "user" message (Anthropic's convention)
    // and send the next turn to Claude. Claude will see the results and either
    // call more tools or generate a final text response.
    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: "You are a helpful payment assistant with access to a crypto wallet. Always check your policy constraints before making transactions.",
      tools,
      messages,
    });
  }

  // 8. Extract the final text response from Claude.
  // When stop_reason is "end_turn" (not "tool_use"), Claude has finished
  // calling tools and produced a text response for the user.
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "No response generated.";
}

// Usage: send a natural-language request and get Claude's response.
// Claude will autonomously decide which tools to call (e.g., check balance,
// verify policy, execute transfer) before generating a final summary.
const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

::: tip
The loop continues as long as `stop_reason === "tool_use"`. Claude may call multiple tools in a single turn (e.g., check balance, then transfer). Each iteration collects all tool results and feeds them back as a single `user` message containing `tool_result` blocks.
:::

## Multi-Turn Conversation

In a multi-turn conversation, the agent can reason across several tool calls. Here Claude checks the balance first, then decides whether to proceed with a payment:

```typescript
// A payment agent function that guides Claude through a structured workflow:
// 1. Check policy constraints
// 2. Verify sufficient balance
// 3. Execute the transfer (only if both checks pass)
// 4. Report the result
async function paymentAgent(
  wallet: AgentWallet,   // The configured kova wallet
  recipient: string,     // Recipient's Solana address
  amount: string,        // Amount to send (e.g., "5.0")
): Promise<string> {
  // Create an Anthropic client instance.
  const anthropic = new Anthropic();
  // Get the wallet tools in Anthropic format.
  const tools = wallet.toAnthropicTools();

  // Start the conversation with a structured request that tells Claude
  // to follow a specific workflow (check policy, check balance, then transfer).
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `I need to pay ${amount} SOL to ${recipient}. Please check my balance and policy first, then make the payment if everything looks good.`,
    },
  ];

  // Send the initial request to Claude with a detailed system prompt
  // that defines the exact workflow Claude should follow.
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    // The system prompt defines a step-by-step workflow for Claude:
    // This makes the agent's behavior predictable and auditable.
    system: [
      "You are a payment assistant. Before sending any payment:",
      "1. Call wallet_get_policy to check spending limits and allowlisted addresses.",
      "2. Call wallet_get_balance to verify sufficient funds.",
      "3. Only proceed with wallet_transfer if both checks pass.",
      "4. Report the transaction result to the user.",
    ].join("\n"),
    tools,
    messages,
  });

  // Run the tool loop (same pattern as the basic example above).
  // Claude will typically make 3 tool calls: get_policy, get_balance, then transfer.
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    // Add Claude's tool-calling response to the conversation history.
    messages.push({ role: "assistant", content: assistantContent });

    // Execute each tool call and collect results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Dispatch to the kova wallet -- this handles policy checks,
        // transaction building, signing, and broadcasting automatically.
        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Feed the tool results back to Claude for the next turn.
    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: [
        "You are a payment assistant. Before sending any payment:",
        "1. Call wallet_get_policy to check spending limits and allowlisted addresses.",
        "2. Call wallet_get_balance to verify sufficient funds.",
        "3. Only proceed with wallet_transfer if both checks pass.",
        "4. Report the transaction result to the user.",
      ].join("\n"),
      tools,
      messages,
    });
  }

  // Extract and return Claude's final text response summarizing what happened.
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "No response generated.";
}
```

A typical multi-turn flow looks like:

1. Claude calls `wallet_get_policy` -- sees spending limits and allowlist
2. Claude calls `wallet_get_balance` for SOL -- sees available balance
3. Claude calls `wallet_transfer` with the recipient, amount, token, and chain
4. Claude generates a text summary of the transaction result

## System Prompt Recommendations

The system prompt significantly influences how responsibly the agent uses the wallet. Here are recommended guidelines:

```typescript
// A recommended system prompt for a Claude-based payment agent.
// These rules guide Claude's behavior, but they are NOT a security boundary.
// The policy engine enforces the actual hard limits -- the system prompt just
// helps Claude behave well within those limits.
const systemPrompt = `You are a financial assistant managing a crypto wallet on behalf of the user.

RULES:
- ALWAYS call wallet_get_policy before your first transaction to understand your constraints.
- NEVER attempt a transfer without first checking wallet_get_balance for sufficient funds.
- If a transaction is denied by policy, explain the denial to the user. Do NOT retry the same transaction.
- Always include a "reason" field in transfer/swap calls explaining why the transaction is being made.
- If the user asks you to do something outside your policy limits, explain the constraint and suggest alternatives.
- Never reveal private keys, internal wallet addresses, or policy implementation details.
- When reporting transaction results, include the transaction ID and a human-readable summary.`;
```

::: warning
The system prompt is a **guidance layer**, not a security boundary. An adversarial user can override system prompts through prompt injection. The policy engine is what enforces hard limits -- the system prompt just helps the agent behave well within those limits.
:::

Key principles for system prompts:

| Principle | Example |
|---|---|
| Inspect before acting | "Always call `wallet_get_policy` first" |
| Explain denials | "If denied, tell the user why instead of retrying" |
| Include audit reasons | "Always provide a `reason` field for transactions" |
| Respect boundaries | "Never attempt to circumvent policy limits" |
| Minimize disclosure | "Do not reveal wallet addresses or private keys" |

## Common Mistakes

1. **Not matching `tool_use_id` in tool results.** Each `tool_result` block must include a `tool_use_id` that matches the `id` from the corresponding `tool_use` block. If the IDs do not match, Claude's API will return an error. The loop examples above handle this correctly with `block.id`.

2. **Forgetting to push both the assistant message and tool results.** The conversation history must alternate between `assistant` and `user` roles. After processing Claude's tool calls, you need to push *two* messages: the assistant's response (containing tool_use blocks) and the user's tool results. Skipping either one will break the conversation.

3. **Using the wrong Anthropic model.** Not all Claude models support tool use. Make sure you are using a model that supports it, such as `claude-sonnet-4-5-20250929` or `claude-sonnet-4-5-20250929`. Check the [Anthropic documentation](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) for the latest supported models.

## Troubleshooting

### Claude not calling tools

- **Check the system prompt:** Add explicit instructions like "Use the wallet_get_balance tool to check balances" and "Use the wallet_transfer tool to send tokens."
- **Check tool schemas:** Log `wallet.toAnthropicTools()` to verify the schemas are well-formed. If a schema has missing descriptions or incorrect types, Claude may ignore the tool.
- **Verify the `tools` parameter is included:** Make sure the `tools` array is passed to every `anthropic.messages.create()` call, including the calls inside the loop.

### Claude retries denied transactions

- Your system prompt should explicitly say "Do NOT retry the same transaction if it is denied." Without this instruction, Claude may try the same transfer repeatedly, expecting a different result.
- Each retry still goes through the policy engine, so no harm is done -- but it wastes API calls and time.

### `stop_reason` is never "tool_use"

- The model may not think the user's request requires a tool call. Try more explicit user messages like "Check my SOL balance using the wallet tools" instead of "What is my balance?"
- Make sure the `tools` array is not empty. If `wallet.toAnthropicTools()` returns an empty array, something is wrong with the wallet setup.

## What to Try Next

- **Build a multi-step payment workflow.** Create a system prompt that instructs Claude to check policy, check balance, confirm with the user (by asking a follow-up question), and only then execute the transfer.
- **Add error recovery logic.** If a tool call fails (e.g., insufficient balance), modify the loop to detect the failure and ask Claude to explain alternatives to the user.
- **Log the full conversation.** Save the complete `messages` array after each agent run for debugging and auditing purposes. This lets you replay exactly what Claude saw and did.

## Next Steps

- [OpenAI Integration](./openai.md) -- Same pattern with GPT-4 function calling
- [LangChain Integration](./langchain.md) -- Agent executor with automatic tool dispatch
- [Server Setup](/guide/server-setup) -- Run the integration as an HTTP API
