# Claude (Anthropic) Integration

This guide shows how to connect a kova wallet to Anthropic's Claude model using the tool-use (function calling) API. Claude can autonomously check balances, review policy constraints, and execute transactions within the limits you define.

## Prerequisites

Install the Anthropic SDK alongside kova:

```bash
npm install @anthropic-ai/sdk kova
```

Set your API key as an environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Tool Format

`wallet.toAnthropicTools()` converts the 8 wallet tools into Anthropic's expected format:

```typescript
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}
```

The key difference from the canonical format is the property name: `parameters` becomes `input_schema`.

```typescript
import { AgentWallet } from "kova";

const tools = wallet.toAnthropicTools();

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

## Full Tool-Use Loop

The following example implements a complete Claude tool-use loop. Claude receives a user message, decides which wallet tools to call, and the loop continues until Claude produces a final text response.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  AllowlistRule,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
} from "kova";

// 1. Set up the wallet (assumes you have configured signer, chain, policy, store)
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

// 2. Create the Anthropic client and get tools
const anthropic = new Anthropic();
const tools = wallet.toAnthropicTools();

// 3. Define the agent loop
async function runAgent(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // 4. Send the initial message with tools
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: "You are a helpful payment assistant with access to a crypto wallet. Always check your policy constraints before making transactions.",
    tools,
    messages,
  });

  // 5. Loop while Claude wants to call tools
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // 6. Process each tool_use block
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
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

    // 7. Push tool results back and send the next message
    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "You are a helpful payment assistant with access to a crypto wallet. Always check your policy constraints before making transactions.",
      tools,
      messages,
    });
  }

  // 8. Extract the final text response
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "No response generated.";
}

// Usage
const reply = await runAgent("Send 2 SOL to 9aE4Uy6gzM...");
console.log(reply);
```

::: tip
The loop continues as long as `stop_reason === "tool_use"`. Claude may call multiple tools in a single turn (e.g., check balance, then transfer). Each iteration collects all tool results and feeds them back as a single `user` message containing `tool_result` blocks.
:::

## Multi-Turn Conversation

In a multi-turn conversation, the agent can reason across several tool calls. Here Claude checks the balance first, then decides whether to proceed with a payment:

```typescript
async function paymentAgent(
  wallet: AgentWallet,
  recipient: string,
  amount: string,
): Promise<string> {
  const anthropic = new Anthropic();
  const tools = wallet.toAnthropicTools();

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `I need to pay ${amount} SOL to ${recipient}. Please check my balance and policy first, then make the payment if everything looks good.`,
    },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
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

  // Run the tool loop (same pattern as above)
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
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

    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
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
