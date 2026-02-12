# Sprint 7 — Examples, Docs, Polish Documentation

**Project:** kova
**Sprint:** 7 — Examples, Docs, Polish (Final Sprint)
**Date:** 2026-02-12

---

## Overview

Sprint 7 is the final sprint of the kova SDK. It delivers the public-facing layer: documentation, runnable examples, an npm publish pipeline, JSDoc polish, an end-to-end integration test suite, and a round of security audit fixes. No new runtime features were added -- this sprint focuses exclusively on making the SDK production-ready for open-source release.

**Deliverables:**

1. **JSDoc Polish** -- Method-level documentation added to 6 public API files
2. **npm Publish Pipeline** -- package.json metadata, LICENSE file, `files` whitelist, `prepublishOnly` script
3. **4 Runnable Examples** -- basic-transfer, claude-agent, policy-playground, telegram-approval
4. **README.md** -- Comprehensive project README (~590 lines)
5. **E2E Integration Test** -- 26 tests across 10 sections
6. **Security Audit Fixes** -- 6 issues identified and resolved

---

## Feature 1: JSDoc Polish

Method-level JSDoc comments were added to 6 public API files. Every public method, constructor, and interface property now has a `/** ... */` comment explaining its purpose, parameters, and behavior.

### Files Polished

| File | Class / Interface | What Was Added |
|------|-------------------|----------------|
| `src/stores/memory.ts` | `MemoryStore` | Class-level doc, method docs for `get`, `set`, `increment`, `append`, `getRecent` |
| `src/stores/sqlite.ts` | `SqliteStore` | Class-level doc, constructor doc, method docs, `SqliteStoreConfig` property docs |
| `src/signers/local.ts` | `LocalSigner` | Class-level warning about dev-only use, method docs for `getAddress`, `sign`, `healthCheck` |
| `src/signers/mpc.ts` | `MPCSigner` | Class-level doc marking Phase 2 status, `MPCSignerConfig` property docs, method docs |
| `src/core/circuit-breaker.ts` | `CircuitBreaker` | Class-level doc explaining store keys, `CircuitBreakerConfig` property docs, method docs for `check`, `recordOutcome`, `reset`, `getConfig` |
| `src/adapters/types.ts` | `ToolParameter` | Interface and property-level docs for `ToolParameter`, `ToolDefinition`, `ToolCallResult` |

### JSDoc Style

All comments follow the same pattern:

```typescript
/**
 * MemoryStore — In-memory store for development and testing.
 * All data is lost when the process exits.
 * TTL expiration is checked on read (lazy expiration).
 */
export class MemoryStore implements Store {
  /** Retrieve a value by key. Returns null if not found or expired. */
  async get(key: string): Promise<string | null> { ... }

  /** Store a value with an optional TTL in seconds. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> { ... }
}
```

```typescript
/**
 * LocalSigner — Holds a Solana Keypair in memory.
 *
 * WARNING: For development and testing only. The private key exists in process memory
 * and can be extracted via heap dumps. Use MPCSigner or EnclaveSigner for production.
 */
export class LocalSigner implements Signer {
  /** Get the wallet's public address (base58-encoded Solana public key). */
  async getAddress(): Promise<string> { ... }

  /** Sign a transaction using the local keypair. Supports both legacy and versioned Solana transactions. */
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> { ... }
}
```

---

## Feature 2: npm Publish Pipeline

The `package.json` was updated with metadata required for npm registry publication. A `LICENSE` file was created. The `files` field restricts what is included in the published tarball.

### package.json Changes

```json
{
  "name": "kova",
  "version": "0.1.0",
  "description": "A policy-constrained crypto wallet SDK for autonomous AI agents",
  "author": "kova contributors",
  "license": "MIT",

  "repository": {
    "type": "git",
    "url": "https://github.com/kova-wallet/kova.git"
  },
  "homepage": "https://github.com/kova-wallet/kova#readme",
  "bugs": {
    "url": "https://github.com/kova-wallet/kova/issues"
  },

  "sideEffects": false,

  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],

  "scripts": {
    "prepublishOnly": "npm run clean && npm run build"
  }
}
```

### Fields Added

| Field | Value | Purpose |
|-------|-------|---------|
| `author` | `"kova contributors"` | npm author metadata |
| `repository` | GitHub URL | Links npm page to source |
| `homepage` | GitHub README URL | npm "Homepage" link |
| `bugs` | GitHub issues URL | npm "Report a bug" link |
| `sideEffects` | `false` | Enables tree-shaking in bundlers |
| `files` | `["dist", "README.md", "LICENSE"]` | Restricts tarball to compiled output + docs |
| `prepublishOnly` | `"npm run clean && npm run build"` | Ensures fresh build before every publish |

### LICENSE File

MIT license created at `LICENSE` in the project root:

```
MIT License

Copyright (c) 2025 kova contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, ...
```

### Tarball Contents

`npm pack` produces a tarball with 159 files totaling 83KB:

- `dist/` -- compiled JavaScript and declaration files
- `README.md` -- project documentation
- `LICENSE` -- MIT license text

All source code (`src/`), tests (`tests/`), examples (`examples/`), docs (`docs/`), and config files are excluded from the published package.

---

## Feature 3: Runnable Examples

Four runnable examples were created in the `examples/` directory. Each is a self-contained TypeScript file that can be run with `npx tsx`.

### Example 1: Basic Transfer (`examples/basic-transfer/`)

The simplest possible kova usage. Creates a wallet with a spending limit policy and executes a SOL transfer on Solana devnet.

**What it demonstrates:**

1. Creating a `Keypair`, `LocalSigner`, `MemoryStore`, and `SolanaAdapter`
2. Building a policy with `Policy.create()` using spending limits and rate limits
3. Converting a `Policy` to a `PolicyEngine` with individual rule instances
4. Creating an `AgentWallet` and calling `getBalance()`, `getPolicy()`, `execute()`
5. Querying transaction history with `getTransactionHistory()`

**Run command:**

```bash
npx tsx examples/basic-transfer/index.ts
```

**Key code:**

```typescript
const policy = Policy.create("basic-demo")
  .spendingLimit({
    perTransaction: { amount: "0.5", token: "SOL" },
    daily: { amount: "2", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .build();

const wallet = new AgentWallet({
  signer: new LocalSigner(keypair),
  chain: new SolanaAdapter({ rpcUrl: RPC_URL }),
  policy: engine,
  store,
});

const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: RECIPIENT, amount: "0.01", token: "SOL" },
  metadata: { reason: "Basic transfer example" },
});
```

### Example 2: Claude Agent (`examples/claude-agent/`)

A full Claude tool-use loop. Demonstrates how to wire kova into an Anthropic Messages API conversation.

**What it demonstrates:**

1. `wallet.toAnthropicTools()` to get tool definitions in Anthropic format
2. Sending tools to the Messages API alongside a system prompt
3. The tool-use loop: iterate while `stop_reason === "tool_use"`
4. `wallet.handleToolCall(block.name, block.input)` to dispatch tool invocations
5. Feeding `tool_result` blocks back to Claude for the next iteration
6. Extracting Claude's final text response

**Prerequisites:**

- `npm install @anthropic-ai/sdk`
- `ANTHROPIC_API_KEY` environment variable

**Run command:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx examples/claude-agent/index.ts
```

**Key code:**

```typescript
const tools = wallet.toAnthropicTools();

let response = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM_PROMPT,
  tools,
  messages,
});

while (response.stop_reason === "tool_use") {
  for (const block of response.content) {
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

  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: toolResults });

  response = await client.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools, messages });
}
```

### Example 3: Policy Playground (`examples/policy-playground/`)

Interactive policy testing with no blockchain connection required. Uses `PolicyEngine` directly with `MemoryStore` to demonstrate policy evaluation behavior.

**What it demonstrates:**

1. Three preset policies: **conservative** (tight limits + allowlist), **liberal** (high limits, no allowlist), **business-hours** (time-window restriction)
2. Evaluating various intents (small transfer, large transfer, swap, unknown recipient) against each policy
3. Rate limit enforcement via rapid-fire intents
4. Spending accumulation across multiple transactions exhausting the daily limit
5. Policy serialization roundtrip (`toJSON()` -> `fromJSON()` -> compare)
6. `Policy.extend()` to create a derived policy
7. Per-rule audit results from `PolicyEvaluationResult` (rule name, result, timing)

**Run command:**

```bash
npx tsx examples/policy-playground/index.ts
```

**Key code:**

```typescript
const conservativePolicy = Policy.create("conservative")
  .spendingLimit({
    perTransaction: { amount: "0.1", token: "SOL" },
    daily: { amount: "0.5", token: "SOL" },
  })
  .allowAddresses([TREASURY])
  .rateLimit({ maxTransactionsPerMinute: 2, maxTransactionsPerHour: 10 })
  .build();

const businessHoursPolicy = Policy.create("business-hours")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .activeHours({
    timezone: "America/New_York",
    windows: [
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    ],
  })
  .build();
```

### Example 4: Telegram Approval (`examples/telegram-approval/`)

Full human-in-the-loop approval flow using Telegram. Executes two transactions: a small one that auto-approves and a large one that triggers a Telegram approval request.

**What it demonstrates:**

1. `TelegramApprovalBot` configuration with token, chat ID, and default timeout
2. `Policy.requireApproval()` with a threshold amount
3. `ApprovalGateRule` integrated into the `PolicyEngine`
4. A transfer below the threshold (0.1 SOL < 0.3 SOL) that auto-approves
5. A transfer above the threshold (0.5 SOL > 0.3 SOL) that sends a Telegram message with Approve/Reject buttons
6. Environment variable validation with helpful setup instructions on missing vars

**Prerequisites:**

- A Telegram bot token from @BotFather
- Your Telegram chat ID

**Run command:**

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
export TELEGRAM_CHAT_ID=987654321
npx tsx examples/telegram-approval/index.ts
```

**Key code:**

```typescript
const approval = new TelegramApprovalBot({
  token: TELEGRAM_BOT_TOKEN!,
  chatId: TELEGRAM_CHAT_ID!,
  defaultTimeout: 120_000,
});

const policy = Policy.create("telegram-approval-demo")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },
    daily: { amount: "5.0", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .requireApproval({
    above: { amount: "0.3", token: "SOL" },
    channel: "telegram",
    timeout: 120_000,
  })
  .build();
```

---

## Feature 4: README.md

A comprehensive project README was written at `README.md` (~590 lines). It serves as the landing page for both the GitHub repository and the npm registry.

### Sections

| Section | Content |
|---------|---------|
| **Header** | One-line tagline, two-sentence description |
| **Features** | 8 bullet points covering policy engine, rules, Telegram, tool integration, audit, circuit breaker, Solana support, TypeScript |
| **Quick Start** | `npm install` + 30-second code example showing wallet creation through execution |
| **Core Concepts: Transaction Intents** | 5 intent types (transfer, swap, mint, stake, custom) with code examples |
| **Core Concepts: Policy Engine** | Multi-rule policy construction, rule ordering, serialization/extension |
| **Core Concepts: AI Agent Integration** | Claude (Anthropic), OpenAI, and LangChain integration code |
| **Core Concepts: Human Approval** | Telegram approval setup with `TelegramApprovalBot` and `ApprovalGateRule` |
| **Core Concepts: Audit Logging** | Hash-chained audit, `verifyIntegrity()`, audit circuit breaker, transaction circuit breaker |
| **API Reference: AgentWallet** | Constructor config table, methods table, `TransactionResult` fields table |
| **API Reference: Policy Builder** | Fluent API, static methods, instance methods |
| **API Reference: Stores** | `MemoryStore` and `SqliteStore` usage |
| **API Reference: Chain Adapters** | `SolanaAdapter` configuration |
| **API Reference: Signers** | `LocalSigner` and `MPCSigner` usage and warnings |
| **Examples** | Links to all 4 examples |
| **Architecture** | Layered architecture summary with pointer to whitepaper |
| **Security** | 6-point security model (fail-closed, circuit breaker, hash chain, mutex, idempotency, no secret leakage) |
| **License** | MIT with link to LICENSE file |

### Key Design Decisions

- **Constructor signatures are accurate.** The Quick Start and all code snippets use the actual `AgentWalletConfig` interface -- no extra positional arguments.
- **Security warnings are inline.** `LocalSigner` has a dev-only warning. `fromSecretKey` notes to never hardcode. Circuit breaker disable has a WARNING comment. Telegram snippets include env var validation guidance.
- **Code examples are copy-pasteable.** Every snippet uses real imports from `"kova"` and works with the published package.

---

## Feature 5: E2E Integration Test

A comprehensive end-to-end test suite was added at `tests/e2e/agent-demo.test.ts`. It covers 26 tests across 10 sections, exercising the full wallet pipeline from intent creation through audit verification.

### Test Architecture

The E2E tests use mock implementations of `Signer` and `ChainAdapter` to avoid requiring a live blockchain connection. The mocks are realistic:

- `createMockSigner()` returns a fixed address and produces 64-byte signatures
- `createMockChain()` returns balances, builds transactions, broadcasts with random tx IDs, and validates addresses
- `buildStandardPolicy()` constructs a production-like policy with rate limits, allowlists, and spending limits

### Test Sections

#### Section 1: Policy Introspection (2 tests)

```
- getPolicy() returns a summary with spending limits, rate limits, and allowlist count
- getAddress() returns the mock signer address
```

Verifies that `getPolicy()` exposes spending limits (`perTransaction`, `daily`), rate limits (`maxPerMinute`, `maxPerHour`), and the allowlisted address count. Verifies `getAddress()` delegates to the signer.

#### Section 2: Successful Transfer Within Limits (3 tests)

```
- transfers 0.1 SOL to an allowlisted address and returns confirmed with txId
- creates an audit log entry with hash chain fields
- includes per-rule audit data in the audit log entry
```

Exercises the happy path: a 0.1 SOL transfer to an allowlisted address within all policy limits. Verifies the result has `status: "confirmed"`, a `txId` starting with `"mock_tx_"`, and an `intentId`. Verifies the audit log entry has a 64-character SHA-256 hash, no `previousHash` (first entry), and 3 per-rule audits (rate-limit, allowlist, spending-limit) all with `result: "ALLOW"`.

#### Section 3: Policy Denial Scenarios (4 tests)

```
- denies a transfer exceeding the per-transaction spending limit
- denies a transfer to a non-allowlisted address
- denies after rate limit is exceeded by rapid transfers
- denies after daily spending limit accumulation is exhausted
```

Tests four distinct denial paths:

| Scenario | Amount | Expected Error |
|----------|--------|----------------|
| Per-tx limit exceeded | 2.0 SOL (limit: 1 SOL) | `"Per-transaction limit exceeded"` |
| Non-allowlisted address | 0.1 SOL to unknown address | `"not in the allowlist"` |
| Rate limit exceeded | 4th transfer within 1 minute (limit: 3/min) | `"Rate limit exceeded"` |
| Daily limit exhausted | 0.4 + 0.2 SOL (daily limit: 0.5 SOL) | `"Daily spending limit exceeded"` |

All denied results have `status: "denied"` and `error.code: "POLICY_DENIED"`.

#### Section 4: Approval Flow (3 tests)

```
- triggers approval for amounts above threshold and proceeds when approved
- denies when the approval channel returns rejected
- skips approval for amounts at or below the threshold
```

Uses a mock `ApprovalChannel` to test the approval gate:

- 0.5 SOL > 0.3 SOL threshold: approval is requested, mock returns `"approved"`, transaction proceeds to confirmed
- 0.5 SOL > 0.3 SOL threshold: mock returns `"rejected"` by `"admin-user"`, result is denied with the rejector's name in the message
- 0.2 SOL <= 0.3 SOL threshold: `requestApproval` is never called, transaction auto-proceeds

#### Section 5: Circuit Breaker (3 tests)

```
- opens after 5 consecutive policy denials and returns CIRCUIT_BREAKER_OPEN on the 6th
- resets after cooldown period expires
- resets denial counter when a transaction is allowed
```

Tests the full circuit breaker lifecycle:

- An `always-deny` rule triggers 5 POLICY_DENIED results, then the 6th returns `CIRCUIT_BREAKER_OPEN`
- With `cooldownMs: 1000`, after waiting 1.1 seconds the circuit resets and the next call reaches the policy engine again (returns POLICY_DENIED, not CIRCUIT_BREAKER_OPEN)
- A `sometimes-deny` rule that allows the 4th call resets the counter; the next 4 denials do not trip the breaker (counter restarted from 0)

#### Section 6: Tool Call Dispatch (5 tests)

```
- wallet_transfer executes and returns a ToolCallResult
- wallet_get_balance returns balance data
- wallet_get_policy returns policy summary
- toAnthropicTools() returns array with expected tool names
- toOpenAITools() returns array with expected structure
```

Verifies the AI agent integration layer:

- `handleToolCall("wallet_transfer", {...})` returns `{ success: true, data: { status: "confirmed", txId: "..." } }`
- `handleToolCall("wallet_get_balance", { token: "SOL" })` returns `{ success: true, data: { token: "SOL", amount: "10.0", decimals: 9 } }`
- `toAnthropicTools()` returns tools with `input_schema.type === "object"` and includes `wallet_transfer`, `wallet_get_balance`, `wallet_get_policy`, `wallet_get_transaction_history`
- `toOpenAITools()` returns tools with `type: "function"` wrapper and `function.parameters.type === "object"`

#### Section 7: Transaction History (2 tests)

```
- reflects a mix of confirmed and denied entries
- history entries have correct intentId and timestamp
```

Executes a successful transfer and a denied transfer, then verifies `getTransactionHistory()` returns both with correct `status`, `intentId`, `timestamp`, and `summary` fields.

#### Section 8: Idempotency (1 test)

```
- returns identical cached result when sending the same intent ID twice
```

Sends the same intent (with `id: "idempotent-e2e-1"`) twice. Verifies the second call returns the cached result (same `txId`) and that `broadcast` was called only once.

#### Section 9: Policy Serialization (1 test)

```
- policy.toJSON() -> Policy.fromJSON() roundtrip produces same config
```

Creates a policy with spending limits, allowlist, rate limits, and approval gate. Serializes with `toJSON()`, deserializes with `Policy.fromJSON()`, and asserts deep equality of the configs.

#### Section 10: Audit Integrity (2 tests)

```
- verifyIntegrity() returns valid after several transactions
- each audit entry has hash and previousHash fields linked correctly
```

Executes 4 transactions (3 confirmed + 1 denied), then:

- `verifyIntegrity()` returns `{ valid: true, entriesChecked: 4, firstBrokenAt: -1 }`
- Manual chain walk: first entry has `hash` defined and `previousHash` undefined; each subsequent entry's `previousHash` matches the preceding entry's `hash`

---

## Feature 6: Security Audit Fixes

A security audit was performed against all Sprint 7 deliverables. Six issues were identified and fixed. All were low severity -- no critical or high-severity findings.

### Issue 1: README Constructor Signatures Incorrect

**Finding:** Early README drafts showed `AgentWallet` constructed with extra positional arguments (e.g., `new AgentWallet(signer, chain, policy, store)`) instead of the actual config object pattern.

**Fix:** All README examples now use the correct `new AgentWallet({ signer, chain, policy: engine, store })` signature.

### Issue 2: README Telegram Snippet Missing Import and Validation

**Finding:** The Telegram approval snippet in the README did not import `Keypair` from `@solana/web3.js` and did not note the need for environment variable validation.

**Fix:** `Keypair` import added. A comment directs readers to the full example for env var validation: `// Validate env vars (see examples/telegram-approval for full validation)`.

### Issue 3: basic-transfer Stale Comment

**Finding:** The `examples/basic-transfer/index.ts` file contained a stale comment referencing `SOLANA_PRIVATE_KEY`, an environment variable that was removed during development.

**Fix:** Comment removed. The example now generates a fresh keypair directly with `Keypair.generate()`.

### Issue 4: Unused allowAllRule in E2E Test

**Finding:** An `allowAllRule` helper was defined in the E2E test file but never used.

**Fix:** The unused rule was removed.

### Issue 5: Circuit Breaker Disable Warning Missing

**Finding:** The README showed how to disable the circuit breaker with `circuitBreaker: false` but did not warn about the security implications.

**Fix:** An inline warning was added:

```typescript
// WARNING: Disabling the circuit breaker removes protection against runaway agent behavior
const walletNoCB = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: false,
});
```

### Issue 6: fromSecretKey Warning Missing

**Finding:** The `LocalSigner` section in the README showed `Keypair.fromSecretKey()` without warning about hardcoded secrets.

**Fix:** An inline comment was added:

```typescript
// or from a secret key (load from secure source -- never hardcode)
const signer2 = new LocalSigner(Keypair.fromSecretKey(secretKeyBytes));
```

### Audit Result

**Verdict: PASS WITH RECOMMENDATIONS**

- Critical issues: 0
- High-severity issues: 0
- Issues found: 6
- Issues fixed: 6
- Outstanding: 0

---

## Final Metrics

| Metric | Value |
|--------|-------|
| **Tests passing** | 918 (892 existing + 26 new e2e) |
| **Test files** | 18 |
| **npm pack size** | 159 files, 83KB |
| **TypeScript errors** | 0 |
| **Security audit** | PASS WITH RECOMMENDATIONS |
| **Critical/high findings** | 0 |
| **Examples** | 4 runnable |
| **README size** | ~590 lines |
| **JSDoc files polished** | 6 |

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `LICENSE` | MIT license text |
| `README.md` | Project documentation (~590 lines) |
| `examples/basic-transfer/index.ts` | Simplest wallet usage example |
| `examples/claude-agent/index.ts` | Claude tool-use loop example |
| `examples/policy-playground/index.ts` | Interactive policy testing example |
| `examples/telegram-approval/index.ts` | Telegram human-in-the-loop example |
| `tests/e2e/agent-demo.test.ts` | 26-test end-to-end integration suite |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Added `author`, `repository`, `homepage`, `bugs`, `sideEffects`, `files`, `prepublishOnly` |
| `src/stores/memory.ts` | Added JSDoc comments to class and all public methods |
| `src/stores/sqlite.ts` | Added JSDoc comments to class, constructor, config, and all public methods |
| `src/signers/local.ts` | Added class-level warning and method-level JSDoc |
| `src/signers/mpc.ts` | Added class-level doc, config property docs, and method docs |
| `src/core/circuit-breaker.ts` | Added class-level doc, config property docs, store key docs, and method docs |
| `src/adapters/types.ts` | Added interface and property docs to `ToolParameter`, `ToolDefinition`, `ToolCallResult` |

---

## Test Coverage Summary

### E2E Test Suite (`tests/e2e/agent-demo.test.ts`)

```
Agent Demo — E2E Workflow
  Policy introspection
    [PASS] getPolicy() returns a summary with spending limits, rate limits, and allowlist count
    [PASS] getAddress() returns the mock signer address
  Successful transfer within limits
    [PASS] transfers 0.1 SOL to an allowlisted address and returns confirmed with txId
    [PASS] creates an audit log entry with hash chain fields
    [PASS] includes per-rule audit data in the audit log entry
  Policy denial scenarios
    [PASS] denies a transfer exceeding the per-transaction spending limit
    [PASS] denies a transfer to a non-allowlisted address
    [PASS] denies after rate limit is exceeded by rapid transfers
    [PASS] denies after daily spending limit accumulation is exhausted
  Approval flow
    [PASS] triggers approval for amounts above threshold and proceeds when approved
    [PASS] denies when the approval channel returns rejected
    [PASS] skips approval for amounts at or below the threshold
  Circuit breaker
    [PASS] opens after 5 consecutive policy denials and returns CIRCUIT_BREAKER_OPEN on the 6th
    [PASS] resets after cooldown period expires
    [PASS] resets denial counter when a transaction is allowed
  Tool call dispatch
    [PASS] wallet_transfer executes and returns a ToolCallResult
    [PASS] wallet_get_balance returns balance data
    [PASS] wallet_get_policy returns policy summary
    [PASS] toAnthropicTools() returns array with expected tool names
    [PASS] toOpenAITools() returns array with expected structure
  Transaction history
    [PASS] reflects a mix of confirmed and denied entries
    [PASS] history entries have correct intentId and timestamp
  Idempotency
    [PASS] returns identical cached result when sending the same intent ID twice
  Policy serialization
    [PASS] policy.toJSON() -> Policy.fromJSON() roundtrip produces same config
  Audit integrity
    [PASS] verifyIntegrity() returns valid after several transactions
    [PASS] each audit entry has hash and previousHash fields linked correctly
```

### Full Test Suite

18 test files, 918 tests:

| Test File | Scope |
|-----------|-------|
| `tests/unit/core/intent.test.ts` | Intent validation and normalization |
| `tests/unit/core/wallet.test.ts` | Wallet execute pipeline |
| `tests/unit/core/adversarial.test.ts` | Adversarial input handling |
| `tests/unit/core/fail-closed.test.ts` | Fail-closed policy evaluation |
| `tests/unit/core/circuit-breaker.test.ts` | Circuit breaker state machine |
| `tests/unit/policy/builder.test.ts` | Policy builder fluent API |
| `tests/unit/policy/engine.test.ts` | Policy engine evaluation |
| `tests/unit/policy/rules.test.ts` | Individual policy rule logic |
| `tests/unit/stores/memory.test.ts` | MemoryStore operations |
| `tests/unit/stores/sqlite.test.ts` | SqliteStore operations |
| `tests/unit/signers/local.test.ts` | LocalSigner signing |
| `tests/unit/signers/mpc.test.ts` | MPCSigner stub behavior |
| `tests/unit/logging/audit.test.ts` | Audit logger, hash chain, integrity |
| `tests/unit/chains/solana-adapter.test.ts` | Solana adapter |
| `tests/unit/chains/solana-utils.test.ts` | Solana utility functions |
| `tests/unit/approval/telegram.test.ts` | Telegram approval bot |
| `tests/unit/adapters/adapters.test.ts` | Tool adapter layer |
| `tests/e2e/agent-demo.test.ts` | End-to-end integration (Sprint 7) |

---

## Sprint Summary

Sprint 7 completes the kova SDK. Over 7 sprints, the project delivered:

- **Sprint 0:** Project scaffolding, core types, store interface
- **Sprint 1:** Policy engine, spending limits, rate limits, allowlists, time windows
- **Sprint 2:** Solana chain adapter (SOL transfers, SPL tokens, Jupiter swaps)
- **Sprint 3:** LocalSigner, MPCSigner stub, transaction signing pipeline
- **Sprint 4:** Telegram approval bot, human-in-the-loop approval gates
- **Sprint 5:** AI agent adapters (Anthropic, OpenAI, LangChain tool formats)
- **Sprint 6:** Audit logging (hash chain, integrity verification, fail-closed), circuit breaker
- **Sprint 7:** Examples, documentation, npm publish pipeline, JSDoc polish, E2E tests, security fixes

The SDK is now ready for `npm publish`.
