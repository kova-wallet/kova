# kova

> A policy-constrained crypto wallet SDK for autonomous AI agents.

Give your AI agents the ability to transact on Solana -- with guardrails.
kova sits between your agent and the blockchain, enforcing spending limits,
allowlists, rate limits, time windows, and human approval gates on every transaction.

## Features

- **Policy engine** with fail-closed evaluation -- rules run sequentially, any denial stops the transaction
- **5 built-in policy rules**: spending limits, address/program allowlists, rate limits, timezone-aware active hours, and human approval gates
- **Telegram approval** for human-in-the-loop workflows above configurable thresholds
- **Native tool integration** for Claude (Anthropic), OpenAI, and LangChain -- agents call wallet operations as tool calls
- **SHA-256 hash-chained audit log** with tamper detection and integrity verification
- **Circuit breaker** that blocks transactions after consecutive policy denials
- **Solana support** with SOL transfers, SPL token transfers, and Jupiter swaps
- **TypeScript-first** with full type safety, zero runtime dependencies beyond Solana SDK and better-sqlite3

## Quick Start

### Installation

```bash
npm install kova
```

### 30-Second Example

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  Policy,
  PolicyEngine,
  SpendingLimitRule,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
} from "kova";

// 1. Create components
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);
const store = new MemoryStore();
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// 2. Build a policy
const policyConfig = Policy.create("demo-policy")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .build();

const engine = new PolicyEngine(
  [new SpendingLimitRule(policyConfig.getConfig().spendingLimit!)],
  store,
);

// 3. Create the wallet
const wallet = new AgentWallet({ signer, chain, policy: engine, store });

// 4. Execute a transfer
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: {
    to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
    amount: "0.5",
    token: "SOL",
  },
});

console.log(result.status);  // "confirmed" | "denied" | "pending" | "failed"
console.log(result.summary); // "Sent 0.5 SOL to Gsbw...QRre"
```

## Core Concepts

### Transaction Intents

Agents express **what** they want, not **how** to do it. An intent is a structured
description of a desired operation. The SDK handles building, signing, and broadcasting
the underlying transaction.

```typescript
import type { TransactionIntent } from "kova";

// Transfer tokens
const transfer: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: { to: "...", amount: "1.5", token: "SOL" },
  metadata: { reason: "Payment for service", agentId: "agent-001" },
};

// Swap tokens (via Jupiter on Solana)
const swap: TransactionIntent = {
  type: "swap",
  chain: "solana",
  params: { fromToken: "SOL", toToken: "USDC", amount: "2.0", maxSlippage: 0.01 },
};

// Mint an NFT
const mint: TransactionIntent = {
  type: "mint",
  chain: "solana",
  params: { collection: "...", metadataUri: "https://arweave.net/..." },
};

// Stake tokens
const stake: TransactionIntent = {
  type: "stake",
  chain: "solana",
  params: { amount: "10", token: "SOL", validator: "..." },
};

// Custom program instruction
const custom: TransactionIntent = {
  type: "custom",
  chain: "solana",
  params: {
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    data: "base64-encoded-instruction-data",
    accounts: [
      { address: "...", isSigner: true, isWritable: true },
    ],
  },
};
```

Every intent passes through the full pipeline: **validate -> normalize -> audit check -> circuit breaker -> policy evaluation -> build tx -> sign -> broadcast -> log**.

### Policy Engine

The policy engine evaluates rules sequentially. Evaluation stops at the first DENY.
If a rule throws an exception, the engine treats it as a DENY (fail-closed). If all
rules pass, the intent is ALLOWED.

```typescript
import {
  Policy,
  PolicyEngine,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  TimeWindowRule,
  ApprovalGateRule,
  MemoryStore,
  SolanaAdapter,
} from "kova";

const store = new MemoryStore();
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Build a policy with multiple rules
const config = Policy.create("production-agent")
  .spendingLimit({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
    monthly: { amount: "500", token: "SOL" },
  })
  .allowAddresses([
    "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
    "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q",
  ])
  .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 30 })
  .activeHours({
    timezone: "America/New_York",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  .requireApproval({ above: { amount: "25", token: "SOL" } })
  .build();

const policyConfig = config.getConfig();

// Construct rules in evaluation order (cheapest first)
const rules = [
  new RateLimitRule(policyConfig.rateLimit!),
  new TimeWindowRule(policyConfig.activeHours!),
  new AllowlistRule({ allowAddresses: policyConfig.allowAddresses }),
  new SpendingLimitRule(policyConfig.spendingLimit!),
  new ApprovalGateRule(policyConfig.approvalGate!),
];

const engine = new PolicyEngine(rules, store);
```

Policies are serializable. Save them as JSON and load them later:

```typescript
// Serialize
const json = config.toJSON();
fs.writeFileSync("policy.json", JSON.stringify(json, null, 2));

// Deserialize
const loaded = Policy.fromJSON(JSON.parse(fs.readFileSync("policy.json", "utf-8")));

// Extend an existing policy
const stricter = Policy.extend(config, "strict-agent")
  .spendingLimit({ perTransaction: { amount: "1", token: "SOL" } })
  .build();
```

### AI Agent Integration

kova exposes 8 tools that AI agents can call: `wallet_transfer`, `wallet_swap`,
`wallet_mint`, `wallet_stake`, `wallet_execute_custom`, `wallet_get_balance`,
`wallet_get_policy`, and `wallet_get_transaction_history`.

#### Claude (Anthropic)

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { AgentWallet } from "kova";

const wallet = new AgentWallet({ signer, chain, policy: engine, store });
const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  tools: wallet.toAnthropicTools(),
  messages: [{ role: "user", content: "Send 0.1 SOL to GsbwXf...QRre" }],
});

// Handle tool calls
for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
    console.log(result);
    // { success: true, data: { status: "confirmed", txId: "...", ... } }
  }
}
```

#### OpenAI

```typescript
import OpenAI from "openai";
import { AgentWallet } from "kova";

const wallet = new AgentWallet({ signer, chain, policy: engine, store });
const client = new OpenAI();

const response = await client.chat.completions.create({
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
  console.log(result);
  // { success: true, data: { token: "SOL", amount: "1.5", decimals: 9 } }
}
```

#### LangChain

```typescript
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createLangChainTools } from "kova";

const walletToolDefs = createLangChainTools(wallet);

const tools = walletToolDefs.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      func: async (input) => t.call(input),
    }),
);

// Pass `tools` to your LangChain agent
```

### Human Approval

The `TelegramApprovalBot` sends an inline-keyboard message to a Telegram chat when
a transaction exceeds the approval threshold. A human taps Approve or Reject. If no
response arrives within the timeout, the transaction is denied.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  ApprovalGateRule,
  TelegramApprovalBot,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
} from "kova";

const store = new MemoryStore();
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Validate env vars (see examples/telegram-approval for full validation)
const botToken = process.env.TELEGRAM_BOT_TOKEN!;
const chatId = process.env.TELEGRAM_CHAT_ID!;

const telegram = new TelegramApprovalBot({
  token: botToken,
  chatId,
  defaultTimeout: 300_000, // 5 minutes
  allowedUserIds: [123456789],  // restrict who can approve
});

const rules = [
  new SpendingLimitRule({ perTransaction: { amount: "100", token: "SOL" } }),
  new ApprovalGateRule({ above: { amount: "10", token: "SOL" } }),
];

const engine = new PolicyEngine(rules, store, telegram);

const keypair = Keypair.generate();
const wallet = new AgentWallet({
  signer: new LocalSigner(keypair),
  chain,
  policy: engine,
  store,
  approval: telegram,
});

// Transactions above 10 SOL will trigger a Telegram approval request.
// The execute() call blocks until the human responds or the timeout expires.
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "...", amount: "15", token: "SOL" },
});

console.log(result.status); // "confirmed" if approved, "pending" or "denied" otherwise
```

### Audit Logging

Every transaction attempt is recorded in a SHA-256 hash-chained audit log. Each entry
stores the hash of the previous entry, creating a tamper-evident chain that can be
verified at any time.

```typescript
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();
const logger = new AuditLogger(store);

// The wallet logs automatically. To verify integrity:
const report = await logger.verifyIntegrity(100);

console.log(report.valid);          // true if chain is intact
console.log(report.entriesChecked); // number of entries verified
console.log(report.firstBrokenAt); // -1 if valid, or index of first tampered entry
```

If the audit log becomes unavailable (store failures), the audit circuit breaker opens
and blocks all new transactions until logging is restored. This prevents unauditable
transactions from executing.

The transaction-level circuit breaker tracks consecutive policy denials. After a
configurable threshold (default: 5), it enters a cooldown period (default: 5 minutes)
to prevent runaway agent behavior.

```typescript
import { AgentWallet, CircuitBreaker } from "kova";

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: {
    threshold: 3,      // open after 3 consecutive denials
    cooldownMs: 60_000, // 1-minute cooldown
  },
});

// WARNING: Disabling the circuit breaker removes protection against runaway agent behavior
const walletNoCB = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: false,
});
```

## API Reference

### AgentWallet

The main class that wires together the policy engine, signer, chain adapter, and store.

```typescript
new AgentWallet(config: AgentWalletConfig)
```

| Config field     | Type                                      | Required | Description                                               |
| ---------------- | ----------------------------------------- | -------- | --------------------------------------------------------- |
| `signer`         | `Signer`                                  | Yes      | Signs transactions (LocalSigner, MPCSigner)               |
| `chain`          | `ChainAdapter`                            | Yes      | Blockchain adapter (SolanaAdapter)                        |
| `policy`         | `PolicyEngine`                            | Yes      | Evaluates intents against rules                           |
| `store`          | `Store`                                   | Yes      | Persists counters, audit log, circuit breaker state       |
| `approval`       | `ApprovalChannel`                         | No       | Human approval channel (TelegramApprovalBot)              |
| `logger`         | `AuditLogger`                             | No       | Custom audit logger (auto-created from store if omitted)  |
| `circuitBreaker` | `Partial<CircuitBreakerConfig> \| false`  | No       | Circuit breaker config, or `false` to disable             |
| `onAuditFailure` | `(error, consecutiveFailures) => void`    | No       | Callback on audit log write failure                       |

**Methods:**

| Method                           | Returns                      | Description                                                  |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `execute(intent)`                | `Promise<TransactionResult>` | Run an intent through the full pipeline                      |
| `getBalance(token)`              | `Promise<TokenBalance>`      | Query token balance for this wallet                          |
| `getAddress()`                   | `Promise<string>`            | Get the wallet's public address                              |
| `getPolicy()`                    | `Promise<PolicySummary>`     | Get a read-only summary of current policy constraints        |
| `getTransactionHistory(limit?)`  | `Promise<TransactionResult[]>` | Get recent transactions from the audit log (default 10, max 1000) |
| `handleToolCall(name, input)`    | `Promise<ToolCallResult>`    | Dispatch an AI agent tool call to the appropriate method     |
| `toAnthropicTools()`             | `AnthropicTool[]`            | Get tool definitions in Anthropic (Claude) format            |
| `toOpenAITools()`                | `OpenAITool[]`               | Get tool definitions in OpenAI format                        |

**TransactionResult fields:**

| Field       | Type                                              | Description                               |
| ----------- | ------------------------------------------------- | ----------------------------------------- |
| `status`    | `"confirmed" \| "denied" \| "pending" \| "failed"` | Outcome of the transaction                |
| `txId`      | `string \| undefined`                             | On-chain transaction signature             |
| `summary`   | `string`                                          | Human-readable description                 |
| `intentId`  | `string`                                          | Unique identifier for the intent           |
| `timestamp` | `number`                                          | When the result was produced               |
| `error`     | `TransactionError \| undefined`                   | Error details if denied or failed          |

### Policy Builder

Fluent API for constructing serializable policy configurations.

```typescript
const config = Policy.create("my-policy")
  .spendingLimit({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
    weekly: { amount: "200", token: "SOL" },
    monthly: { amount: "500", token: "SOL" },
  })
  .allowAddresses(["addr1", "addr2"])
  .denyAddresses(["addr3"])
  .allowPrograms(["programId1"])
  .denyPrograms(["programId2"])
  .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 30 })
  .activeHours({
    timezone: "UTC",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  .requireApproval({ above: { amount: "25", token: "SOL" }, timeout: 300_000 })
  .build();
```

| Static method             | Description                                   |
| ------------------------- | --------------------------------------------- |
| `Policy.create(name)`     | Start a new policy builder                    |
| `Policy.fromJSON(config)` | Load a policy from a serialized config object |
| `Policy.extend(base, name)` | Create a new builder pre-filled from an existing policy |

| Instance method   | Description                              |
| ----------------- | ---------------------------------------- |
| `toJSON()`        | Serialize to a plain config object       |
| `getName()`       | Get the policy name                      |
| `getConfig()`     | Get the full configuration (deep copy)   |

### Stores

#### MemoryStore

In-memory store for development and testing. All data is lost when the process exits.

```typescript
import { MemoryStore } from "kova";

const store = new MemoryStore();
```

#### SqliteStore

Persistent store backed by SQLite via better-sqlite3. Uses WAL mode for concurrent reads.

```typescript
import { SqliteStore } from "kova";

const store = new SqliteStore({ path: "./wallet.db" });

// Use ":memory:" for in-memory SQLite (useful for testing)
const memStore = new SqliteStore({ path: ":memory:" });
```

Both stores implement the `Store` interface: `get`, `set`, `increment`, `append`, `getRecent`.

### Chain Adapters

#### SolanaAdapter

Connects to a Solana RPC endpoint. Supports SOL transfers, SPL token transfers, and
Jupiter-powered swaps.

```typescript
import { SolanaAdapter } from "kova";

const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",       // "processed" | "confirmed" | "finalized"
  jupiterApiUrl: "https://quote-api.jup.ag/v6",     // optional, for swaps
  jupiterPriceApiUrl: "https://price.jup.ag/v6",    // optional, for USD valuation
});
```

### Signers

#### LocalSigner

Holds a Solana `Keypair` in memory. Supports both legacy and versioned transactions.

```typescript
import { Keypair } from "@solana/web3.js";
import { LocalSigner } from "kova";

const signer = new LocalSigner(Keypair.generate());
// or from a secret key (load from secure source -- never hardcode)
const signer2 = new LocalSigner(Keypair.fromSecretKey(secretKeyBytes));
```

> **Warning:** LocalSigner is for development and testing only. The private key exists
> in process memory and can be extracted via heap dumps.

#### MPCSigner

Interface stub for MPC-based signing (not yet implemented -- planned for Phase 2).

```typescript
import { MPCSigner } from "kova";

const signer = new MPCSigner({
  provider: "lit-protocol",
  keyId: "key-123",
  threshold: 2,
});
// All methods throw "not yet implemented" errors
```

## Examples

- [Basic Transfer](examples/basic-transfer/) -- Send SOL with spending limits
- [Claude Agent](examples/claude-agent/) -- Claude agent with wallet tools
- [Policy Playground](examples/policy-playground/) -- Interactive policy testing
- [Telegram Approval](examples/telegram-approval/) -- Human-in-the-loop approval

## Architecture

kova follows a layered architecture: **intents** describe what the agent wants,
the **policy engine** decides whether to allow it, and the **chain adapter** handles
blockchain-specific transaction construction and broadcasting. The signer is isolated
behind an interface so that key material never touches the policy or chain layers. All
operations flow through a single `execute()` method that enforces serialization (mutex),
idempotency (intent ID deduplication), and audit logging (hash-chained entries). See
the [whitepaper](docs/whitepaper.md) for the full design rationale.

## Security

- **Fail-closed by default.** If a policy rule throws an exception, the transaction is denied. If the audit log is unavailable, transactions are blocked. If a rule is misconfigured, the PolicyEngine constructor rejects it at build time.
- **Circuit breaker.** After N consecutive policy denials (default 5), the wallet enters a cooldown period and refuses all transactions. This prevents a compromised or misbehaving agent from retrying indefinitely.
- **Hash-chained audit log.** Every transaction attempt is recorded with a SHA-256 hash linking it to the previous entry. `verifyIntegrity()` walks the chain to detect tampering or gaps.
- **Serialized execution.** The `execute()` method holds a mutex to prevent concurrent calls from bypassing time-of-check/time-of-use policy checks.
- **Idempotency.** Duplicate intent IDs return cached results instead of re-executing.
- **No secret leakage.** Internal errors in tool call handlers are sanitized before being returned to the agent. The Telegram bot redacts its token from error messages.

**Responsible disclosure:** If you discover a security vulnerability, please report it privately by opening a GitHub security advisory at [github.com/kova-wallet/kova](https://github.com/kova-wallet/kova/security/advisories/new).

## License

MIT -- see [LICENSE](LICENSE) for details.
