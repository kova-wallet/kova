# Security Model

`kova` is designed with a **fail-closed, defense-in-depth** security model. Every component defaults to denying transactions when uncertain, and multiple layers of protection prevent a single failure from compromising funds.

## Fail-Closed Design

The SDK's core security principle is **fail-closed**: when in doubt, deny. This principle applies at every layer.

### Rule Evaluation

If a policy rule throws an exception during evaluation, the result is `DENY` -- not `ALLOW`. The error message is captured in the audit trail for debugging.

```typescript
// If a rule throws...
class BuggyRule implements PolicyRule {
  name = "buggy";
  async evaluate(): Promise<PolicyDecision> {
    throw new Error("database connection lost");
  }
}

// ...the PolicyEngine returns DENY with the error message
// Result: { decision: "DENY", rule: "buggy", reason: "Rule evaluation error: database connection lost" }
```

### Audit Down = Block All

If the audit logger experiences too many consecutive write failures (default: 3), it opens its internal circuit breaker. When the audit circuit is open, the `AgentWallet` refuses to process **any** transactions. This ensures the SDK never operates without a functioning audit trail.

```typescript
// Audit circuit breaker opens after 3 consecutive failures
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  onAuditFailure: (error, consecutiveFailures) => {
    console.error(`Audit failure #${consecutiveFailures}:`, error);
    if (consecutiveFailures >= 3) {
      // All transactions are now blocked
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
// This throws at build time, not at runtime
Policy.create("bad-policy")
  .spendingLimit({ daily: { amount: "-5", token: "SOL" } })
  .build();
// Error: Invalid Spending limit amount: -5
```

### No Approval Channel = Deny

If the `ApprovalGateRule` triggers but no `ApprovalChannel` is configured, the result is `DENY` -- not a hang or crash.

### Empty PolicyEngine = Reject

The `PolicyEngine` constructor throws if no rules are provided. An engine with zero rules would allow all transactions unconditionally.

## Mutex Serialization

The `AgentWallet.execute()` method uses an internal mutex to serialize all transaction execution. Only one `execute()` call runs at a time.

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
try {
  // ... process tool call
} catch {
  return {
    success: false,
    error: "An internal error occurred while processing the tool call.",
  };
}
```

This prevents internal error details (stack traces, database paths, internal state) from being leaked to the agent. The agent sees a generic error message, while the full error is available in the audit log for operators.

## Token Redaction in Telegram Bot

The `TelegramApprovalBot` automatically redacts the bot token from all error messages:

```typescript
// If the Telegram API returns an error, the token is replaced:
// Before: "Telegram API sendMessage failed (401): {"ok":false} with token 123456:ABC"
// After:  "Telegram API sendMessage failed (401): {"ok":false} with token [REDACTED]"
```

This prevents the bot token from appearing in logs, error reports, or audit entries.

## Input Validation

The SDK validates all inputs at the boundary before processing:

- **Amount validation**: Rejects `NaN`, `Infinity`, `-Infinity`, negative values, and zero. Only finite positive numbers are accepted.
- **Input length limits**: Addresses are limited to 128 characters, token symbols to 64, data fields to 1 MB, URIs to 2,048 characters, and reasons to 1,024 characters.
- **Runtime type checks**: All tool handler inputs are validated with `typeof` checks before use. This prevents type confusion attacks from AI-generated inputs.

## SSRF Protection

The `SolanaAdapter` validates all URLs (RPC, Jupiter API, Jupiter Price API) at construction time:

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
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();
const logger = new AuditLogger(store);

// After some transactions...
const report = await logger.verifyIntegrity(100);

if (report.valid) {
  console.log(`Integrity verified: ${report.entriesChecked} entries checked`);
} else {
  console.error(`Integrity broken at entry ${report.firstBrokenAt}: ${report.error}`);
}
```

The `IntegrityReport` structure:

```typescript
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
import { AgentWallet } from "kova";

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: {
    threshold: 5,       // Open after 5 consecutive denials
    cooldownMs: 300_000, // Block for 5 minutes
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
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: false, // Explicitly disable
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

### Policy Configuration

- [ ] Set conservative spending limits. Start low and increase as confidence grows.
- [ ] Configure an allowlist of approved recipient addresses.
- [ ] Enable rate limiting to cap transaction frequency.
- [ ] Set active hours to match your operational schedule.
- [ ] Configure human approval for all transactions above a meaningful threshold.

### Approval Channel

- [ ] Set `allowedUserIds` on the `TelegramApprovalBot` to restrict who can approve.
- [ ] Use a private Telegram chat or channel, not a public group.
- [ ] Store the bot token in environment variables, never in source code.
- [ ] Test the approval flow before deploying.

### Persistence

- [ ] Use `SqliteStore` (or a custom production store), never `MemoryStore`.
- [ ] Back up the SQLite database regularly.
- [ ] Monitor audit log integrity with periodic `verifyIntegrity()` calls.

### Monitoring

- [ ] Configure `onAuditFailure` to alert your operations team.
- [ ] Monitor the circuit breaker status via `wallet.getPolicy()`.
- [ ] Log all `TransactionResult` objects for external monitoring.
- [ ] Set up alerts for consecutive denials or unusual transaction patterns.

### Network Security

- [ ] Use a private or rate-limited RPC endpoint, not a public one.
- [ ] Use HTTPS for all RPC and API endpoints (enforced by `SolanaAdapter`).
- [ ] Run the agent process in an isolated environment (container, VM).
- [ ] Restrict network egress to only the required endpoints (RPC, Telegram API, Jupiter API).
- [ ] Be aware that `SolanaAdapter` blocks connections to private/internal network addresses (SSRF protection).

### Testing

- [ ] Test all policy rules with both allow and deny scenarios.
- [ ] Test the full pipeline end-to-end on devnet before mainnet.
- [ ] Test the circuit breaker by simulating consecutive denials.
- [ ] Test audit integrity verification.
- [ ] Test idempotency by submitting the same intent ID twice.
