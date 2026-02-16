<p align="center">
  <img src="docs-site/public/logo.svg" width="120" alt="kova" />
</p>

<h1 align="center">kova</h1>

<p align="center">
  Policy-constrained crypto wallet SDK for AI agents.
  <br />
  <a href="https://0xkeysersoze.github.io/kova/"><strong>Documentation &rarr;</strong></a>
</p>

---

Give your AI agents the ability to transact on Solana — with guardrails. kova sits between your agent and the blockchain, enforcing spending limits, allowlists, rate limits, time windows, and human approval gates on every transaction.

## Features

- **Policy engine** — composable rules evaluated sequentially, deny-by-default, fail-closed
- **5 built-in rules** — spending limits, address allowlists, rate limits, time windows, approval gates
- **AI tool integration** — first-class support for Claude, OpenAI, and LangChain
- **Human approval** — Telegram bot for human-in-the-loop on high-value transactions
- **Audit log** — SHA-256 hash-chained, tamper-evident transaction log
- **Circuit breaker** — automatic cooldown after consecutive policy denials
- **Solana** — SOL transfers, SPL tokens, Jupiter swaps

## Install

```bash
npm install kova
```

## Quick Start

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet, Policy, PolicyEngine,
  SpendingLimitRule, LocalSigner, MemoryStore, SolanaAdapter,
} from "kova";

// 1. Create a signer — holds the private key, signs transactions
const signer = new LocalSigner(Keypair.generate());

// 2. Create a store — tracks spending totals, rate-limit counters, and audit entries
const store = new MemoryStore();

// 3. Create a chain adapter — connects to Solana and broadcasts transactions
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// 4. Define a policy — max 1 SOL per transaction, 5 SOL daily limit
const policy = Policy.create("demo")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .build();

// 5. Build the policy engine from the serialized policy config
const config = policy.toJSON();
const engine = new PolicyEngine(
  [new SpendingLimitRule(config.spendingLimit!)],
  store,
);

// 6. Assemble the wallet — combines signer, chain, policy, and store
const wallet = new AgentWallet({ signer, chain, policy: engine, store });

// 7. Execute a transfer intent — policy is evaluated before the transaction is sent
const result = await wallet.execute({
  type: "transfer",       // intent type: "transfer" | "swap" | "custom"
  chain: "solana",        // target chain
  params: {
    to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",  // recipient address
    amount: "0.5",        // amount in SOL
    token: "SOL",         // token to send
  },
});

// 8. Check the result
console.log(result.status);  // "confirmed" | "denied" | "pending" | "failed"
console.log(result.summary); // "Sent 0.5 SOL to Gsbw...QRre"
```

## How It Works

Every call to `wallet.execute(intent)` follows this pipeline:

```
Intent → Validate → Audit Check → Circuit Breaker → Policy Engine → Build Tx → Sign → Broadcast → Log
```

**Intents** describe what the agent wants (transfer, swap, mint, stake, custom). The **policy engine** evaluates rules sequentially — the first DENY stops execution. If all rules pass, the **chain adapter** builds and broadcasts the transaction. The **signer** is isolated behind an interface so key material never touches the policy or chain layers.

## AI Integration

kova exposes wallet operations as tool definitions that agents can call directly.

### Claude

```typescript
// Send a message to Claude with kova wallet tools attached
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  tools: wallet.toAnthropicTools(),   // converts wallet operations to Anthropic tool format
  messages: [{ role: "user", content: "Send 0.1 SOL to GsbwXf...QRre" }],
});

// Process Claude's response — execute any tool calls it makes
for (const block of response.content) {
  if (block.type === "tool_use") {
    // handleToolCall routes the tool name + input through the policy engine
    const result = await wallet.handleToolCall(block.name, block.input);
  }
}
```

### OpenAI

```typescript
// Send a message to OpenAI with kova wallet tools attached
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools: wallet.toOpenAITools(),    // converts wallet operations to OpenAI function-calling format
  messages: [{ role: "user", content: "Check my SOL balance" }],
});

// Extract the first tool call from the response
const toolCall = response.choices[0]?.message.tool_calls?.[0];
if (toolCall) {
  // Parse the function arguments and route through the policy engine
  const result = await wallet.handleToolCall(
    toolCall.function.name,
    JSON.parse(toolCall.function.arguments),
  );
}
```

### LangChain

```typescript
import { createLangChainTools } from "kova";

// Convert kova wallet operations into LangChain-compatible tool objects
const tools = createLangChainTools(wallet);
// Pass these tools to any LangChain agent — policy enforcement is handled automatically
```

## Policy Rules

Compose rules to match your risk profile. Rules are evaluated in order — put the cheapest checks first.

```typescript
const policy = Policy.create("production")
  // Cap spending: 10 SOL per tx, 50 SOL per day
  .spendingLimit({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  })
  // Only allow transfers to these approved addresses
  .allowAddresses(["addr1", "addr2"])
  // Limit to 5 transactions per minute to prevent rapid-fire abuse
  .rateLimit({ maxTransactionsPerMinute: 5 })
  // Restrict to weekday business hours (Eastern time)
  .activeHours({
    timezone: "America/New_York",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  // Require human approval via Telegram for transactions above 25 SOL
  .requireApproval({ above: { amount: "25", token: "SOL" } })
  .build();
```

| Rule | What it does |
|------|-------------|
| **SpendingLimit** | Per-transaction, daily, weekly, monthly caps |
| **Allowlist** | Restrict to approved addresses and programs |
| **RateLimit** | Max transactions per minute/hour |
| **TimeWindow** | Restrict to business hours (timezone-aware) |
| **ApprovalGate** | Require human approval above a threshold |

Policies are serializable — save as JSON, load later, or extend existing policies:

```typescript
// Serialize a policy to JSON for storage or transport
const json = policy.toJSON();

// Reconstruct a policy from saved JSON
const loaded = Policy.fromJSON(json);

// Extend an existing policy with tighter rules (inherits all parent rules)
const stricter = Policy.extend(policy, "strict").spendingLimit({ ... }).build();
```

## Stores

| Store | Use case |
|-------|----------|
| `MemoryStore` | Development and testing (data lost on exit) |
| `SqliteStore` | Production (persistent, WAL mode, encrypted counters) |

## Examples

| Example | Description |
|---------|-------------|
| [basic-transfer](examples/basic-transfer/) | Send SOL with spending limits |
| [claude-agent](examples/claude-agent/) | Claude agent with wallet tools |
| [telegram-approval](examples/telegram-approval/) | Human-in-the-loop approval via Telegram |
| [policy-playground](examples/policy-playground/) | Interactive policy testing |

Run any example:

```bash
cp .env.example .env    # copy the template and fill in your RPC URL, keys, etc.
npx tsx examples/basic-transfer/index.ts   # run any example with tsx
```

## Security

- **Fail-closed** — exceptions in policy rules deny the transaction; audit log failures block all transactions
- **Circuit breaker** — consecutive denials trigger automatic cooldown
- **Hash-chained audit** — SHA-256 linked entries with `verifyIntegrity()` tamper detection
- **Serialized execution** — mutex prevents TOCTOU race conditions
- **Idempotent** — duplicate intent IDs return cached results
- **No secret leakage** — errors sanitized before returning to agents

Report vulnerabilities via [GitHub Security Advisory](https://github.com/0xKeyserSoze/kova/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).
