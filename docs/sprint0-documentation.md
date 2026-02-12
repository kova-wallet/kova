# Sprint 0 Documentation — Project Foundation

## What Was Built

Sprint 0 establishes the complete project skeleton for **kova**, a TypeScript SDK that gives AI agents policy-constrained access to crypto wallets. This sprint delivers:

- Full project configuration (TypeScript, Vitest, ESLint, Prettier)
- All core interfaces and types for the 3-layer architecture
- Working implementations: `MemoryStore`, `LocalSigner`, `Policy` builder, `PolicyEngine`, `AuditLogger`
- Stub implementations for everything else (fail-closed)
- 209 passing tests with 94.5% code coverage
- npm-publishable package structure

No actual blockchain transactions are executed in Sprint 0 — this sprint is purely foundational.

---

## Architecture Overview

```
Agent (Claude, GPT, etc.)
  │
  ▼
┌─────────────────────────────┐
│  AgentWallet                │  ← Single entry point for agents
│  (src/core/wallet.ts)       │
├─────────────────────────────┤
│  PolicyEngine               │  ← Evaluates intents against rules
│  (src/policy/engine.ts)     │
│  ├── SpendingLimitRule      │
│  ├── AllowlistRule          │
│  ├── RateLimitRule          │
│  ├── TimeWindowRule         │
│  └── ApprovalGateRule       │
├─────────────────────────────┤
│  Signer                     │  ← Signs transactions
│  (src/signers/)             │
│  ├── LocalSigner            │  ← Dev/testing (implemented)
│  └── MPCSigner              │  ← Production (stub)
├─────────────────────────────┤
│  ChainAdapter               │  ← Chain-specific operations
│  (src/chains/)              │
│  └── SolanaAdapter          │  ← Primary chain (stub)
├─────────────────────────────┤
│  Store                      │  ← Spending counters, tx logs
│  (src/stores/)              │
│  ├── MemoryStore            │  ← Dev/testing (implemented)
│  └── SqliteStore            │  ← Production (stub)
└─────────────────────────────┘
```

---

## Core Components

### 1. AgentWallet (`src/core/wallet.ts`)

The main entry point. Wires together all components. Exposes only safe, policy-gated methods to agents.

```typescript
import { AgentWallet, PolicyEngine, Policy, LocalSigner, MemoryStore, SolanaAdapter } from "kova";
import { Keypair } from "@solana/web3.js";

const wallet = new AgentWallet({
  signer: new LocalSigner(Keypair.generate()),
  chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }),
  policy: new PolicyEngine([/* rules */], store),
  store: new MemoryStore(),
});

// Available methods:
await wallet.getAddress();            // Get wallet public address
await wallet.execute(intent);         // Execute a transaction (Sprint 1)
await wallet.getBalance("SOL");       // Get token balance (Sprint 1)
await wallet.getPolicy();             // Get policy summary (Sprint 2)
await wallet.getTransactionHistory(); // Get tx history (Sprint 2)
```

**Security**: All internal components (`signer`, `chain`, `policy`, `store`) are `private readonly`. Agents cannot access them directly.

### 2. Transaction Intents (`src/core/intent.ts`)

Structured descriptions of what an agent wants to do. Agents express *what*, not *how*.

```typescript
import type { TransactionIntent } from "kova";

const intent: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "7xKp...3mF9",
    amount: "0.5",
    token: "SOL",
  },
  metadata: {
    reason: "Payment for API access",
    agentId: "research-agent-01",
  },
};
```

**Supported intent types**: `transfer`, `swap`, `mint`, `stake`, `custom`

**Type guards** are provided for safe narrowing:
```typescript
import { isTransferIntent, isSwapIntent } from "kova";

if (isTransferIntent(intent)) {
  console.log(intent.params.to);  // TypeScript knows this is TransferParams
}
```

### 3. Policy Builder (`src/policy/builder.ts`)

Fluent API for constructing policy configurations with compile-time type safety and runtime validation.

```typescript
import { Policy } from "kova";

const policy = Policy.create("my-agent-policy")
  .spendingLimit({
    perTransaction: { amount: "0.5", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .allowAddresses(["addr1...", "addr2..."])
  .allowPrograms(["JUP6..."])
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .activeHours({
    timezone: "UTC",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  .requireApproval({
    above: { amount: "1.0", token: "SOL" },
    channel: "telegram",
    timeout: 300_000,
  })
  .build();

// Serialize to JSON
const json = policy.toJSON();

// Load from JSON (validates on load)
const loaded = Policy.fromJSON(json);
```

**Validation rules enforced**:
- Policy name is required (non-empty)
- Spending limit amounts must be positive numbers with non-empty token
- Rate limit values must be positive integers
- Active hours require valid timezone, HH:MM time format
- Approval gate requires positive amount and timeout
- Cooldown requires positive `waitMinutes`
- Same address cannot appear in both allow and deny lists

### 4. Policy Engine (`src/policy/engine.ts`)

Evaluates intents against an ordered list of rules. Stops at the first DENY or PENDING.

```typescript
import { PolicyEngine, SpendingLimitRule, AllowlistRule } from "kova";

const engine = new PolicyEngine(
  [
    new RateLimitRule({ maxTransactionsPerMinute: 5 }),
    new AllowlistRule({ allowAddresses: ["addr1..."] }),
    new SpendingLimitRule({ daily: { amount: "5", token: "SOL" } }),
  ],
  store,
);

const decision = await engine.evaluate(intent);
// decision.decision: "ALLOW" | "DENY" | "PENDING"
```

**Key behaviors**:
- Requires at least one rule (empty rules array throws)
- Rules evaluated sequentially, cheapest first
- First DENY or PENDING stops evaluation
- Injectable `now` timestamp for deterministic testing

### 5. Store Interface (`src/stores/interface.ts`)

Minimal 5-operation interface for pluggable persistence.

```typescript
import { MemoryStore } from "kova";

const store = new MemoryStore();

await store.set("key", "value", 3600);     // Set with 1hr TTL
await store.get("key");                     // Get (returns null if expired)
await store.increment("counter", 1.5);     // Atomic increment, returns new value
await store.append("log", "entry");        // Append to list
await store.getRecent("log", 10);          // Get last 10 entries (newest first)
```

**MemoryStore behaviors**:
- Lazy TTL expiration (checked on read)
- `increment()` is synchronous internally (no race conditions)
- Non-numeric values treated as 0 on increment
- `getRecent(key, 0)` returns empty array
- `clear()` for test cleanup

### 6. Signer Interface (`src/signers/interface.ts`)

Abstraction over key management. Start simple, upgrade to MPC later.

```typescript
import { LocalSigner } from "kova";
import { Keypair } from "@solana/web3.js";

// For development:
const signer = new LocalSigner(Keypair.generate());
await signer.getAddress();    // "7xKp...3mF9"
await signer.healthCheck();   // true
```

**LocalSigner caveats** (documented for security):
- Private key exists in process memory — for dev/testing only
- Validates chain === "solana" before signing
- Validates signature is exactly 64 bytes (Ed25519) after signing

---

## Project Structure

```
kova/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── core/
│   │   ├── wallet.ts             # AgentWallet class
│   │   ├── intent.ts             # TransactionIntent types + type guards
│   │   └── result.ts             # TransactionResult, TokenBalance types
│   ├── policy/
│   │   ├── engine.ts             # PolicyEngine (implemented)
│   │   ├── builder.ts            # Policy builder + validation (implemented)
│   │   ├── types.ts              # All policy types
│   │   └── rules/                # 5 rule stubs (fail-closed)
│   ├── signers/
│   │   ├── interface.ts          # Signer interface
│   │   ├── local.ts              # LocalSigner (implemented)
│   │   └── mpc.ts                # MPCSigner (stub)
│   ├── stores/
│   │   ├── interface.ts          # Store interface
│   │   ├── memory.ts             # MemoryStore (implemented)
│   │   └── sqlite.ts             # SqliteStore (stub)
│   ├── chains/solana/            # SolanaAdapter (stub)
│   ├── approval/                 # TelegramApprovalBot (stub)
│   ├── adapters/                 # Claude/OpenAI/LangChain (stubs)
│   └── logging/                  # AuditLogger (implemented)
├── tests/unit/                   # 209 tests
├── implementation/
│   ├── audits/                   # Security audit report
│   ├── testing/                  # QA test report
│   └── results/                  # Issue resolution report
└── docs/                         # This documentation
```

---

## Design Decisions

### Why fail-closed stubs?
All unimplemented policy rules return DENY. If code is shipped that depends on these rules before they're implemented, transactions are blocked rather than allowed. This is the safe default for a wallet SDK.

### Why require at least one rule?
A `PolicyEngine` with zero rules would allow every transaction unconditionally. This violates the deny-by-default principle and would create a dangerous "looks secure but isn't" situation.

### Why deep copy in Policy?
`toJSON()` and `getConfig()` return `structuredClone()` copies. This prevents callers from mutating the internal policy state after construction, which could bypass validation.

### Why synchronous increment?
The original `MemoryStore.increment()` used `await` between read and write, creating a theoretical race condition under concurrent `Promise.all` usage. The rewritten version operates directly on the `Map` with no async gaps.

---

## What's Next

**Sprint 1** (Core Skeleton): Wire `AgentWallet.execute()` end-to-end with mock chain adapter. The skeleton flow: intent → policy evaluation → sign → mock result.

**Sprint 2** (Policy Engine): Implement all 5 policy rules for real. Replace DENY stubs with actual spending limit checks, allowlist validation, rate limiting, time windows, and approval gates.

**Sprint 3** (Solana): Real blockchain transactions on devnet — SOL transfers, SPL tokens, Jupiter swaps.
