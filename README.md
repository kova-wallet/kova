<p align="center">
  <img src="docs-site/public/logo.svg" width="120" alt="kova" />
</p>

<h1 align="center">kova</h1>

<p align="center">
  Policy-constrained crypto wallet SDK for AI agents.
  <br />
  <a href="https://kova-wallet.github.io/kova/"><strong>Documentation &rarr;</strong></a>
</p>

<p align="center">
  <a href="https://github.com/kova-wallet/kova/actions/workflows/ci.yml"><img src="https://github.com/kova-wallet/kova/actions/workflows/ci.yml/badge.svg?branch=prod" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@kova/wallet"><img src="https://img.shields.io/npm/v/@kova/wallet" alt="npm version" /></a>
  <a href="https://github.com/kova-wallet/kova/blob/prod/LICENSE"><img src="https://img.shields.io/npm/l/@kova/wallet" alt="license" /></a>
  <img src="https://img.shields.io/node/v/@kova/wallet" alt="node version" />
</p>

---

AI agents need to transact on-chain. Without guardrails, a single hallucination or prompt injection can drain a wallet. kova sits between your agent and the blockchain, enforcing spending limits, allowlists, rate limits, time windows, and human approval gates on every transaction before it touches the network.

```
Agent → Intent → Policy Engine → Build Tx → Sign → Broadcast → Audit Log
                     ↓ DENY
                 Circuit Breaker
```

## Why kova

- Your agent says "send 100 SOL" but your policy caps it at 5 SOL per transaction — **denied**.
- Your agent tries to send funds to an unknown address — **denied** by allowlist.
- A prompt injection tricks your agent into rapid-fire transfers — **denied** by rate limit, then **circuit breaker** kicks in.
- A high-value transaction needs human sign-off — **held** until approved via Telegram.
- Every transaction, approved or denied, is recorded in a **tamper-evident audit log**.

## Features

| Category | Details |
|----------|---------|
| **Policy Engine** | 5 composable rules, deny-by-default, fail-closed, two-phase evaluation |
| **Spending Limits** | Per-transaction, daily, weekly, monthly caps (per-token and USD) |
| **Address Allowlist** | Restrict transfers to approved addresses; denylist support |
| **Rate Limiting** | Max transactions per minute/hour with store-backed counters |
| **Time Windows** | Restrict to business hours (timezone-aware, multiple windows) |
| **Approval Gates** | Human-in-the-loop via Telegram for high-value transactions |
| **AI Adapters** | First-class tool definitions for Claude, OpenAI, and LangChain |
| **Signers** | LocalSigner (dev), MpcSigner with Turnkey provider (production) |
| **Stores** | MemoryStore (dev), SqliteStore with encryption (production) |
| **Solana** | SOL transfers, SPL tokens, Jupiter swaps, transaction simulation |
| **Audit Log** | SHA-256 hash-chained, optional AES-256-GCM encryption |
| **Circuit Breaker** | Auto-cooldown after consecutive denials |
| **Security** | 196 audit findings remediated across 14 CRIT, 27 HIGH, 38 MED, 31 LOW |

## Important

> **ESM-only** — kova is published as ES modules only. Use `import`, not `require()`. Your `tsconfig.json` should have `"module": "Node16"` and `"moduleResolution": "Node16"`.

> **Single-instance deployment** — The SDK's mutex, circuit breaker, idempotency cache, and spending counters are designed for a single Node.js process per store. Running multiple processes against the same store without external distributed locking can cause TOCTOU races, spending limit bypasses, and audit log inconsistencies. For multi-process deployments, use `RedisStore` with per-instance `storePrefix`, or implement external coordination (e.g., Redis Redlock).

> **Native dependencies are optional** — `better-sqlite3` (for `SqliteStore`) and `ioredis` (for `RedisStore`) are optional peer dependencies. Install only what you need. `better-sqlite3` requires C++ build tools (see [Installation](#install)). If you only need `MemoryStore` for development, no native dependencies are required.

## Quick Start

### Install

```bash
npm install @kova/wallet
```

For persistent storage (single server):
```bash
npm install better-sqlite3          # requires C++ build tools
```

For multi-server deployments:
```bash
npm install ioredis
```

### Minimal example

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet, Policy, LocalSigner, MemoryStore, SolanaAdapter,
} from "@kova/wallet";

const signer = new LocalSigner(Keypair.generate());
const store  = new MemoryStore();
const chain  = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com", network: "devnet" });

const policy = Policy.create("demo")
  .spendingLimit({ perTransaction: { amount: "1", token: "SOL" }, daily: { amount: "5", token: "SOL" } })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .build();

const wallet = new AgentWallet({ signer, chain, policy, store });

const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre", amount: "0.5", token: "SOL" },
});

console.log(result.status);  // "confirmed" | "denied" | "pending" | "failed"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AgentWallet                             │
│                                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌─────────┐  ┌────────────┐  │
│  │  Signer  │  │ Policy Engine │  │  Store  │  │   Chain    │  │
│  │          │  │              │  │         │  │  Adapter   │  │
│  │ Local    │  │ SpendingLimit│  │ Memory  │  │            │  │
│  │ MPC      │  │ Allowlist    │  │ SQLite  │  │  Solana    │  │
│  │ Turnkey  │  │ RateLimit    │  │ Prefixed│  │  (more     │  │
│  │          │  │ TimeWindow   │  │         │  │   coming)  │  │
│  │          │  │ ApprovalGate │  │         │  │            │  │
│  └──────────┘  └──────────────┘  └─────────┘  └────────────┘  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Audit Log   │  │   Circuit    │  │    AI Adapters       │  │
│  │  (hash-chain)│  │   Breaker    │  │  Claude · OpenAI ·   │  │
│  │              │  │              │  │  LangChain           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Every call to `wallet.execute(intent)` follows this pipeline:

1. **Validate** the intent structure and parameters
2. **Check audit log** integrity (fail-closed if tampered)
3. **Circuit breaker** check (auto-cooldown after consecutive denials)
4. **Policy engine** evaluates rules sequentially — first DENY stops execution
5. **Build transaction** via the chain adapter
6. **Sign** via the signer (key material never touches policy or chain layers)
7. **Broadcast** to the network
8. **Log** the result to the hash-chained audit trail

## Policy Engine

Compose rules to match your risk profile. Rules are evaluated in order — the first DENY stops execution.

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
| **SpendingLimit** | Per-transaction, daily, weekly, monthly caps. Rolling TTL windows with BigInt precision. |
| **Allowlist** | Restrict to approved addresses/programs. Separate denylist support. |
| **RateLimit** | Max transactions per minute/hour. Store-backed counters. |
| **TimeWindow** | Restrict to business hours. Timezone-aware, multiple windows per day. |
| **ApprovalGate** | Require human approval above a threshold. Telegram bot with inline buttons. |

Policies use **two-phase evaluation**: a dry-run phase prevents counter inflation on denied transactions, so a denied spend doesn't eat into your rate limit or spending budget.

Policies are fully serializable:

```typescript
const json = policy.toJSON();                                    // save as JSON
const loaded = Policy.fromJSON(json);                            // reconstruct later
const stricter = Policy.extend(policy, "strict").spendingLimit({ ... }).build();  // extend
```

## AI Integration

kova exposes wallet operations as tool definitions that AI agents call directly. Policy enforcement happens automatically on every tool call.

### Claude (Anthropic)

```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-6-20250827",
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
import { createLangChainTools } from "@kova/wallet";

const tools = createLangChainTools(wallet);
// Pass to any LangChain agent — policy enforcement is automatic
```

### Available tools

| Tool | Description |
|------|-------------|
| `wallet_transfer` | Transfer SOL or SPL tokens |
| `wallet_swap` | Swap tokens via Jupiter |
| `wallet_get_balance` | Query wallet balance |
| `wallet_get_transaction_history` | Query past transactions |
| `wallet_get_policy` | View current policy rules |
| `wallet_mint` | Mint NFTs *(coming soon)* |
| `wallet_stake` | Stake tokens *(coming soon)* |
| `wallet_execute_custom` | Raw instructions (dangerous, opt-in only) |

## Signers

| Signer | Use case |
|--------|----------|
| `LocalSigner` | Development. In-memory Ed25519 signing. Guarded against production use. |
| `MpcSigner` | Production. Hardware-backed signing via pluggable providers. Retry with backoff, configurable timeout, cancellation via AbortSignal. |
| `TurnkeyProvider` | MPC provider for [Turnkey](https://www.turnkey.com/). Drop-in for MpcSigner. |

The `Signer` interface is minimal — `getAddress()`, `sign()`, `healthCheck()`, `destroy()` — so you can implement your own provider for Fireblocks, Lit Protocol, or any other MPC backend.

## Stores

| Store | Use case |
|-------|----------|
| `MemoryStore` | Development. In-memory, data lost on exit. Guarded against production. |
| `SqliteStore` | Production (single server). Persistent, WAL mode, HMAC-protected counters, optional encryption. Requires `better-sqlite3`. |
| `RedisStore` | Production (multi-server). Shared state via Redis. Natively atomic operations. Requires `ioredis`. |
| `PrefixedStore` | Multi-wallet. Wraps any store, namespaces keys per wallet to prevent counter collisions. |

> **Floating-point precision note**: `MemoryStore` counters use IEEE 754 doubles, which can accumulate drift over many increments. For high-precision accounting, prefer `SqliteStore` (native numeric types) or `RedisStore` (INCRBYFLOAT).

## Approval Channels

| Channel | How it works |
|---------|-------------|
| `TelegramApprovalBot` | Sends approval requests as Telegram messages with inline approve/reject buttons. Configurable timeout (default 5 min). User whitelist support. |

The `ApprovalChannel` interface (`requestApproval()`) is open for custom implementations — Slack, Discord, email, or any other channel.

## Security

| Protection | Implementation |
|------------|---------------|
| **Fail-closed** | Exceptions in policy rules deny the transaction. Audit log failures block all transactions. |
| **Two-phase evaluation** | Dry-run prevents counter inflation on denied transactions. |
| **Circuit breaker** | Consecutive denials trigger automatic cooldown with per-agent isolation. |
| **Hash-chained audit** | SHA-256 linked entries with `verifyIntegrity()` tamper detection. Optional AES-256-GCM encryption. |
| **Serialized execution** | FIFO async mutex prevents TOCTOU race conditions. |
| **Approval integrity** | SHA-256 intent hashing prevents TOCTOU between approval and execution. |
| **DNS pinning** | SSRF and DNS rebinding protection for RPC endpoints. |
| **Idempotency** | Duplicate intent IDs return cached results. |
| **Error sanitization** | Errors are sanitized before returning to agents — no secret leakage. |
| **Counter integrity** | HMAC-protected store counters detect tampering. |
| **Defense-in-depth** | Multiple overlapping security layers at every level of the stack. |

196 audit findings remediated: 14 Critical, 27 High, 38 Medium, 31 Low.

Report vulnerabilities via [GitHub Security Advisory](https://github.com/kova-wallet/kova/security/advisories/new).

## Project Structure

```
kova/
├── src/
│   ├── core/           # AgentWallet, intents, results, circuit breaker
│   ├── policy/         # Policy builder, engine, and 5 rule implementations
│   ├── signers/        # LocalSigner, MpcSigner, TurnkeyProvider
│   ├── stores/         # MemoryStore, SqliteStore, RedisStore, PrefixedStore
│   ├── chains/solana/  # SolanaAdapter, transfers, Jupiter swaps
│   ├── approval/       # TelegramApprovalBot, ApprovalChannel interface
│   ├── adapters/       # Claude, OpenAI, LangChain tool adapters
│   └── logging/        # Hash-chained audit logger
├── tests/              # 1100+ unit and integration tests
└── docs-site/          # VitePress documentation
```

## Development

```bash
git clone https://github.com/kova-wallet/kova.git
cd kova
npm install
npm run typecheck       # type checking
npm run lint            # eslint
npx vitest run          # run all tests
npm run build           # compile to dist/
```

## License

MIT — see [LICENSE](LICENSE).
