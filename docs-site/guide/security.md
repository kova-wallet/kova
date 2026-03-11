# Security Model

::: info What you'll learn
- The fail-closed principle: how every component defaults to deny when uncertain
- Mutex serialization that prevents TOCTOU race conditions on spending limits
- Idempotency deduplication that prevents duplicate payments on retries
- Error sanitization that keeps internal details away from AI agents
- The full production security checklist for deploying with real funds
:::

`kova` is designed with a **fail-closed, defense-in-depth** security model. Every component defaults to denying transactions when uncertain, and multiple layers of protection prevent a single failure from compromising funds.

## Security Audit

The Kova SDK underwent a comprehensive security audit conducted by **8 independent engineering teams** (40 engineers total). The audit produced **196 findings** across all severity levels, every one of which has been addressed:

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 14 | All remediated |
| High | 27 | All remediated |
| Medium | 38 | All remediated |
| Low | 31 | All remediated (8 accepted risk) |
| Informational | 86 | Documented |

The audit covered the full SDK surface: wallet core, policy engine, signer implementations, store backends, chain adapters, approval channels, and tool dispatch.

::: tip
Security audit findings are referenced throughout the source code using tags like `CRIT-13`, `HIGH-06`, `MED-21`. These tags map to entries in the audit report under `security-audits/`.
:::

## Fail-Closed Design

The SDK's core security principle is **fail-closed**: when in doubt, deny. This principle applies at every layer.

### Rule Evaluation

If a policy rule throws an exception during evaluation, the result is `DENY` -- not `ALLOW`. The error message is captured in the audit trail for debugging.

```typescript
// Example: a buggy custom rule that throws an exception during evaluation.
// Even if a rule has a bug or loses its database connection, the SDK does NOT
// default to allowing the transaction. Instead, it treats the exception as a DENY.
// This is the fail-closed principle — errors always result in denial, never approval.
class BuggyRule implements PolicyRule {
  name = "buggy";  // Every rule has a name used in audit logs and denial messages

  async evaluate(): Promise<PolicyDecision> {
    // This simulates an unexpected error (e.g., database connection lost, network timeout).
    // In production, this could happen if the store backend becomes unavailable.
    throw new Error("database connection lost");
  }
}

// When the PolicyEngine encounters this exception, it catches it and returns:
// Result: { decision: "DENY", rule: "buggy", reason: "Rule evaluation error: database connection lost" }
// The error details are recorded in the audit log for post-incident investigation.
```

### Audit Down = Block All

If the audit logger experiences too many consecutive write failures (default: 3), it opens its internal circuit breaker. When the audit circuit is open, the `AgentWallet` refuses to process **any** transactions. This ensures the SDK never operates without a functioning audit trail.

```typescript
// Configure the AgentWallet with an audit failure callback.
// This callback fires every time an audit log write fails, giving you the chance
// to alert your operations team before the circuit breaker opens.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,

  // onAuditFailure is called each time writing an audit entry fails.
  // - error: the Error object from the failed write attempt.
  // - consecutiveFailures: how many writes in a row have failed.
  // After 3 consecutive failures, the audit circuit breaker opens and ALL transactions are blocked.
  onAuditFailure: (error, consecutiveFailures) => {
    console.error(`Audit failure #${consecutiveFailures}:`, error);
    if (consecutiveFailures >= 3) {
      // At this point, the audit circuit breaker has opened.
      // No transactions will be processed until audit logging is restored.
      // Alert your operations team to investigate the store backend.
      alertOpsTeam("Audit logging is down. All transactions blocked.");
    }
  },
});
```

### Invalid Config = Reject at Build

The `Policy` builder validates all configuration at `build()` time:

- Negative or zero amounts are rejected
- Invalid time formats are rejected
- Overlapping allow/deny lists are rejected
- Empty rule names are rejected
- Non-positive rate limits are rejected

```typescript
// This throws an error at build() time, NOT at runtime during transaction execution.
// The Policy builder validates all configuration eagerly, so invalid policies
// are caught during initialization rather than when the first transaction is attempted.
// This is important because a runtime error could leave the system in an inconsistent state.
Policy.create("bad-policy")
  .spendingLimit({ daily: { amount: "-5", token: "SOL" } })  // Negative amount — invalid!
  .build();
// Error: Invalid Spending limit amount: -5
```

### No Approval Channel = Deny

If the `ApprovalGateRule` triggers but no `ApprovalChannel` is configured, the result is `DENY` -- not a hang or crash.

### Empty PolicyEngine = Reject

The `PolicyEngine` constructor throws if no rules are provided. An engine with zero rules would allow all transactions unconditionally.

## Two-Phase Policy Evaluation

The PolicyEngine uses a two-phase evaluation strategy that prevents counter inflation from denied transactions:

1. **Phase 1 (Dry Run)**: All rules are evaluated using a `DryRunStore` -- a temporary wrapper that intercepts counter writes without modifying the real store. This determines whether the transaction _would_ be allowed.
2. **Phase 2 (Commit)**: If Phase 1 allows, counters are committed to the real store using a `Phase2TrackingStore`. If any Phase 2 operation fails, all counter updates are rolled back.

This eliminates a class of bugs where a denied transaction inflates spending counters, causing subsequent legitimate transactions to be incorrectly denied.

::: tip
This is similar to how databases use write-ahead logs with commit/rollback. Phase 1 checks feasibility; Phase 2 commits state.
:::

## Policy Denial Sanitization

When policy denials are returned to AI agents, the denial reasons are sanitized to prevent information leakage:

- **Rule names** are replaced with the generic label `"policy rule"` so agents cannot identify which specific rule blocked them
- **Threshold values** and counter details are stripped to prevent binary-search probing of limits
- **Full details** are preserved in the audit log for human operators

This prevents a malicious or probing agent from using denial reasons to reverse-engineer policy limits.

## Mutex Serialization

The `AgentWallet.execute()` method uses an internal mutex to serialize all transaction execution. Only one `execute()` call runs at a time.

> The execute mutex uses a FIFO (first-in, first-out) queue, ensuring that transactions are processed in submission order. This prevents starvation where a rapidly-retrying agent could cut ahead of other pending transactions.

**Why this matters:** Without serialization, concurrent `execute()` calls could bypass spending limits through a time-of-check-time-of-use (TOCTOU) race condition:

```
// WITHOUT mutex (vulnerable):
// Two concurrent calls, each for 6 SOL, with a 10 SOL daily limit
Call A: read counter → 0 SOL spent
Call B: read counter → 0 SOL spent
Call A: 0 + 6 = 6 < 10 → ALLOW, write counter → 6
Call B: 0 + 6 = 6 < 10 → ALLOW, write counter → 6
// Both pass! But 12 SOL was spent against a 10 SOL limit.

// WITH mutex (safe):
Call A: acquire lock → read 0 → ALLOW → write 6 → release lock
Call B: acquire lock → read 6 → 6 + 6 = 12 > 10 → DENY → release lock
```

::: warning
The mutex is in-process only. If you run multiple wallet instances in separate processes pointing at the same store, the mutex cannot prevent cross-process races. Use database-level locking (e.g., SQLite WAL + transactions) for multi-process deployments.
:::

## Idempotency Deduplication

Every successfully executed transaction is cached in the store with the intent ID as the key and a 24-hour TTL. If the same intent ID is submitted again, the cached result is returned without re-executing the pipeline.

**Security implications:**

- Prevents duplicate transactions caused by network retries or agent bugs
- Only `confirmed` and `failed` results are cached. `denied` and `pending` results are NOT cached, because the denial condition may change (rate limit expires, approval arrives)
- The 24-hour TTL prevents unbounded store growth
- Cached entries are validated on read -- corrupted or malformed entries are ignored and the pipeline re-executes

## Error Sanitization in handleToolCall

The `handleToolCall()` method wraps all operations in a try/catch that sanitizes error messages before returning them to the AI agent:

```typescript
// Inside handleToolCall(), all errors are caught and replaced with a generic message.
// This prevents the AI agent from seeing internal implementation details
// such as stack traces, database file paths, secret key references, or internal state.
// The full error is still available in the audit log for human operators.
try {
  // ... process tool call (maps to wallet.execute(), getBalance(), etc.)
} catch {
  // Return a sanitized error — no internal details are leaked to the AI agent.
  return {
    success: false,
    error: "An internal error occurred while processing the tool call.",
  };
}
```

This prevents internal error details (stack traces, database paths, internal state) from being leaked to the agent. The agent sees a generic error message, while the full error is available in the audit log for operators.

## Secret Redaction in Approval Channels

The `WebhookApprovalChannel` automatically redacts HMAC secrets from error messages:

```typescript
// If an approval channel error contains sensitive data (like HMAC secrets or API tokens),
// the SDK automatically replaces it with "[REDACTED]" before logging or returning the error.
// This prevents secrets from appearing in logs, error reports, or audit entries.
```

This prevents secrets from appearing in logs, error reports, or audit entries.

## Input Validation

The SDK validates all inputs at the boundary before processing:

- **Amount validation**: Rejects `NaN`, `Infinity`, `-Infinity`, negative values, and zero. Only finite positive numbers are accepted.
- **Input length limits**: Addresses are limited to 128 characters, token symbols to 64, data fields to 64 KB (65,536 bytes), URIs to 2,048 characters, and reasons to 1,024 characters.
- **Runtime type checks**: All tool handler inputs are validated with `typeof` checks before use. This prevents type confusion attacks from AI-generated inputs.

## SSRF Protection

The `SolanaAdapter` validates all URLs (RPC endpoint) at construction time:

- **HTTPS enforced** for all non-localhost URLs
- **Private networks blocked**: RFC 1918 addresses (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), and zero addresses are rejected
- **HTTP allowed** only for `localhost`, `127.0.0.1`, and `::1` (local development)

See [Chain Adapters: URL Validation](/guide/chain-adapters#url-validation-and-ssrf-protection) for details.

## Key Material Security

The `LocalSigner` includes two methods to reduce key exposure:

- **`destroy()`**: Zeros out the secret key bytes in memory. After destruction, `sign()` throws.
- **`toJSON()`**: Returns only the public address. Prevents accidental secret key leakage via `JSON.stringify()`.

## Hash Chain Tamper Detection

Every audit entry includes a SHA-256 hash computed from:

1. The entry's content (serialized as recursive canonical JSON with sorted keys at all levels)
2. A domain separator (`\x00kova:audit:v1\x00`) to prevent length-extension attacks
3. The hash of the previous entry

This creates a linked hash chain where tampering with any entry invalidates all subsequent entries.

```
Entry 0: hash = SHA256(content_0 + "\x00kova:audit:v1\x00" + "")
Entry 1: hash = SHA256(content_1 + "\x00kova:audit:v1\x00" + hash_0)
Entry 2: hash = SHA256(content_2 + "\x00kova:audit:v1\x00" + hash_1)
...
```

Hash verification uses **timing-safe comparison** (`crypto.timingSafeEqual`) to prevent side-channel attacks. The audit logger serializes all writes through an internal mutex to prevent hash chain corruption from concurrent log calls.

### Verifying Integrity

```typescript
// Import the AuditLogger and a store implementation.
// AuditLogger manages the tamper-evident hash chain of audit entries.
import { AuditLogger, MemoryStore } from "@kova/wallet";

// Create a store and an audit logger instance.
// The audit logger writes entries to the store and maintains the hash chain.
const store = new MemoryStore();
const logger = new AuditLogger(store);

// After some transactions have been executed and logged...
// Verify the integrity of the last 100 audit entries.
// This walks the hash chain backwards, recomputing each entry's hash
// and comparing it to the stored hash using timing-safe comparison.
// If any entry has been tampered with (modified, deleted, or reordered),
// the verification will fail at that point.
const report = await logger.verifyIntegrity(100);

if (report.valid) {
  // All 100 entries pass hash chain verification — no tampering detected.
  console.log(`Integrity verified: ${report.entriesChecked} entries checked`);
} else {
  // Tampering or corruption detected at a specific entry.
  // The firstBrokenAt index tells you exactly where the chain breaks.
  // Investigate the audit log entries around this index for signs of tampering.
  console.error(`Integrity broken at entry ${report.firstBrokenAt}: ${report.error}`);
}
```

The `IntegrityReport` structure:

```typescript
// The result of an audit log integrity verification.
// Tells you whether the hash chain is intact and, if not, where it breaks.
interface IntegrityReport {
  /** Whether the entire chain is valid */
  valid: boolean;
  /** Total entries checked */
  entriesChecked: number;
  /** Index of the first broken link (0-based from oldest), or -1 if valid */
  firstBrokenAt: number;
  /** Description of the integrity issue, if any */
  error?: string;
}
```

Possible integrity errors:

- `"Entry N is missing hash field"` -- an entry was inserted without the hash chain
- `"Entry N previousHash does not match entry N-1 hash"` -- the chain link is broken
- `"Entry N hash does not match recomputed hash (tampered or corrupted)"` -- the entry content was modified after writing

## Circuit Breaker for Runaway Agents

The `CircuitBreaker` tracks consecutive policy denials and enters a cooldown period after a configurable threshold. This prevents a runaway agent from hammering the wallet with requests that will be denied.

```typescript
// Import AgentWallet and configure it with a circuit breaker.
import { AgentWallet } from "@kova/wallet";

// Create a wallet with a circuit breaker that activates after 5 consecutive denials.
// The circuit breaker is a safety mechanism that protects the system from runaway agents
// that keep retrying denied transactions in a tight loop.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: {
    threshold: 5,       // Open the circuit after 5 consecutive policy denials
    cooldownMs: 300_000, // Block ALL transactions for 5 minutes (300,000ms) while the circuit is open
  },
});
```

### How It Works

```
Tx 1 → DENY   (counter: 1)
Tx 2 → DENY   (counter: 2)
Tx 3 → DENY   (counter: 3)
Tx 4 → DENY   (counter: 4)
Tx 5 → DENY   (counter: 5)  ← threshold reached, circuit opens
Tx 6 → DENY (circuit breaker, not policy)  ← blocked for 5 minutes
...
(5 minutes later)
Tx 7 → circuit resets, normal evaluation resumes
```

- `ALLOW` resets the counter to zero
- `PENDING` (awaiting approval) does not count as a denial
- The circuit breaker operates **before** policy evaluation, so it cannot be bypassed by reconfiguring rules
- State is persisted via the `Store` interface, so it survives process restarts

### Disabling the Circuit Breaker

```typescript
// Explicitly disable the circuit breaker using { dangerouslyDisable: true }.
// Passing `false` is deprecated — use the explicit form instead.
// Without a circuit breaker, a runaway agent can submit unlimited denied requests.
// This is NOT recommended for production — only use for testing or special cases.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: { dangerouslyDisable: true }, // Explicitly disable — no cooldown after consecutive denials
});
```

## Production Security Checklist

::: danger
Review this checklist before deploying with real funds.
:::

### Key Management

- [ ] Do NOT use `LocalSigner` with real private keys. Use a hardware-backed signer or MPC solution.
- [ ] Store private keys in secure enclaves, HSMs, or MPC networks.
- [ ] Rotate keys periodically.
- [ ] Call destroy() on LocalSigner during shutdown to zero out key material
- [ ] Use rotateKey() for periodic key rotation

### Policy Configuration

- [ ] Set conservative spending limits. Start low and increase as confidence grows.
- [ ] Configure an allowlist of approved recipient addresses.
- [ ] Enable rate limiting to cap transaction frequency.
- [ ] Set active hours to match your operational schedule.
- [ ] Configure human approval for all transactions above a meaningful threshold.
- [ ] Configure enabledTools to restrict which tools the agent can invoke -- default to read-only
- [ ] Set authToken for caller authentication

### Approval Channel

- [ ] Restrict who can approve transactions in your approval channel implementation.
- [ ] Use HMAC-signed webhooks (`WebhookApprovalChannel`) to prevent tampering.
- [ ] Store HMAC secrets and API tokens in environment variables, never in source code.
- [ ] Test the approval flow before deploying.

### Persistence

- [ ] Use `SqliteStore` (or a custom production store), never `MemoryStore`.
- [ ] Back up the SQLite database regularly.
- [ ] Monitor audit log integrity with periodic `verifyIntegrity()` calls.
- [ ] Use createStore() factory to wrap stores with timeout protection
- [ ] Configure encryptionKey on SqliteStore for AES-256-GCM encryption
- [ ] Set a persistent hmacKey on SqliteStore for counter integrity
- [ ] Provide a persistent idempotencyHmacKey to AgentWallet

### Monitoring

- [ ] Configure `onAuditFailure` to alert your operations team.
- [ ] Monitor the circuit breaker status via `wallet.getPolicy()`.
- [ ] Log all `TransactionResult` objects for external monitoring.
- [ ] Set up alerts for consecutive denials or unusual transaction patterns.

### Network Security

- [ ] Use a private or rate-limited RPC endpoint, not a public one.
- [ ] Use HTTPS for all RPC and API endpoints (enforced by `SolanaAdapter`).
- [ ] Run the agent process in an isolated environment (container, VM).
- [ ] Restrict network egress to only the required endpoints (RPC, approval webhook endpoints).
- [ ] Be aware that `SolanaAdapter` blocks connections to private/internal network addresses (SSRF protection).

### Testing

- [ ] Test all policy rules with both allow and deny scenarios.
- [ ] Test the full pipeline end-to-end on devnet before mainnet.
- [ ] Test the circuit breaker by simulating consecutive denials.
- [ ] Test audit integrity verification.
- [ ] Test idempotency by submitting the same intent ID twice.
