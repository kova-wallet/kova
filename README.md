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

// Components
const signer = new LocalSigner(Keypair.generate());
const store  = new MemoryStore();
const chain  = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Policy — max 1 SOL per tx, 5 SOL daily
const policy = Policy.create("demo")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .build();

const config = policy.toJSON();
const engine = new PolicyEngine(
  [new SpendingLimitRule(config.spendingLimit!)],
  store,
);

// Wallet
const wallet = new AgentWallet({ signer, chain, policy: engine, store });

// Execute
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre", amount: "0.5", token: "SOL" },
});

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
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  tools: wallet.toAnthropicTools(),
  messages: [{ role: "user", content: "Send 0.1 SOL to GsbwXf...QRre" }],
});

for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
  }
}
```

### OpenAI

```typescript
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools: wallet.toOpenAITools(),
  messages: [{ role: "user", content: "Check my SOL balance" }],
});

const toolCall = response.choices[0]?.message.tool_calls?.[0];
if (toolCall) {
  const result = await wallet.handleToolCall(
    toolCall.function.name,
    JSON.parse(toolCall.function.arguments),
  );
}
```

### LangChain

```typescript
import { createLangChainTools } from "kova";

const tools = createLangChainTools(wallet);
// Pass to your LangChain agent
```

## Policy Rules

Compose rules to match your risk profile. Rules are evaluated in order — put the cheapest checks first.

```typescript
const policy = Policy.create("production")
  .spendingLimit({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  })
  .allowAddresses(["addr1", "addr2"])
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .activeHours({
    timezone: "America/New_York",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
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
const json = policy.toJSON();
const loaded = Policy.fromJSON(json);
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
cp .env.example .env    # fill in your values
npx tsx examples/basic-transfer/index.ts
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
