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
- **Circuit breaker** — automatic cooldown with per-agent isolation
- **Dashboard** — web admin UI for devnet testing, policy management, and transaction monitoring
- **Security hardened** — 196 audit findings remediated (14 CRIT, 27 HIGH, 38 MED, 31 LOW)
- **Solana** — SOL transfers, SPL tokens, Jupiter swaps (devnet by default)

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Git

### Clone and install

```bash
git clone https://github.com/0xKeyserSoze/kova.git
cd kova
npm install
```

### Verify the build

```bash
npm run lint        # 0 errors, 0 warnings
npm run typecheck   # clean
npx vitest run      # 1147 tests pass
npm run build       # compile
```

### Run the examples

Examples use Solana devnet — no real funds needed.

```bash
cp .env.example .env                             # fill in RPC URL if needed (defaults to devnet)
npx tsx examples/basic-transfer/index.ts         # generates a keypair, airdrops SOL, sends a transfer
```

The `claude-agent` example requires an `ANTHROPIC_API_KEY` in `.env`.

### Run the dashboard

```bash
cd dashboard
npm install
npx tsx wallet/generate.ts    # one-time: generates a devnet keypair
npm run dev                   # starts at http://localhost:3000
```

Fund the wallet at [faucet.solana.com](https://faucet.solana.com) using the address printed by `generate.ts`. The dashboard auto-loads the keypair on startup with a default policy (0.01 SOL per-tx, 1 SOL daily, 5 txns/min rate limit).

### Use kova in your own project

```bash
npm install kova
```

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet, Policy, PolicyEngine,
  SpendingLimitRule, LocalSigner, MemoryStore, SolanaAdapter,
} from "kova";

// 1. Create a signer — holds the private key, signs transactions
// Note: LocalSigner is for development only. Use MpcSigner in production.
const signer = new LocalSigner(Keypair.generate(), { dangerouslyAllowInProduction: true });

// 2. Create a store — tracks spending totals, rate-limit counters, and audit entries
// Note: MemoryStore is for development only. Use SqliteStore in production.
const store = new MemoryStore({ dangerouslyAllowInProduction: true });

// 3. Create a chain adapter — connects to Solana devnet
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  network: "devnet",
});

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

All consumer code should pass `network: "devnet"` to `SolanaAdapter` and the `dangerouslyAllowInProduction: true` flags to `LocalSigner` and `MemoryStore` during development.

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
  model: "claude-sonnet-4-5-20250929",
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
| [dashboard](dashboard/) | Admin UI for devnet testing and policy management |

## Security

kova underwent a comprehensive security audit (8 teams, 40 engineers) with **196 findings remediated** across all severity levels. See [security-audits/](security-audits/) for full reports.

- **Security audited** — 14 Critical, 27 High, 38 Medium, 31 Low findings — all remediated
- **Fail-closed** — exceptions in policy rules deny the transaction; audit log failures block all transactions
- **Two-phase policy evaluation** — dry-run prevents counter inflation on denied transactions
- **Circuit breaker** — consecutive denials trigger automatic cooldown with per-agent isolation
- **Hash-chained audit** — SHA-256 linked entries with `verifyIntegrity()` tamper detection
- **Serialized execution** — FIFO async mutex prevents TOCTOU race conditions
- **DNS pinning** — SSRF and DNS rebinding protection for RPC endpoints
- **Idempotent** — duplicate intent IDs return cached results
- **No secret leakage** — errors sanitized before returning to agents

Report vulnerabilities via [GitHub Security Advisory](https://github.com/0xKeyserSoze/kova/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).
