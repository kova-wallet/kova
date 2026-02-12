# Sprint 7 Security Audit

## Scope

This audit covers the Sprint 7 "Examples, Docs, Polish" deliverables:

- **4 example files**: `examples/basic-transfer/index.ts`, `examples/policy-playground/index.ts`, `examples/claude-agent/index.ts`, `examples/telegram-approval/index.ts`
- **README.md**: All code snippets (Quick Start, Policy Engine, Claude/OpenAI/LangChain integration, Telegram approval, Audit Logging, Circuit Breaker, API Reference, Signers)
- **package.json**: npm pack surface (`files` field, `prepublishOnly`, distribution contents)
- **tests/e2e/agent-demo.test.ts**: Mock accuracy, security model fidelity, assertion correctness
- **JSDoc comments**: Public API documentation on `AgentWallet`, `PolicyEngine`, `Policy`, `AuditLogger`, `LocalSigner`, `TelegramApprovalBot`
- **LICENSE**: Standard MIT license verification

---

## Findings

### S7-01: README code snippets pass incorrect constructor arguments to policy rules -- Severity: HIGH

**File:** `README.md` (lines 57, 180, 183-184, 313-314)

**Description:**
Multiple README code snippets pass extra `store` and/or `chain` arguments to rule constructors that only accept a single `config` parameter:

```typescript
// README line 57 — Quick Start
new SpendingLimitRule(policyConfig.getConfig().spendingLimit!, store, chain)

// README lines 180-184 — Policy Engine section
new RateLimitRule(policyConfig.rateLimit!, store)
new SpendingLimitRule(policyConfig.spendingLimit!, store, chain)
new ApprovalGateRule(policyConfig.approvalGate!, chain)

// README lines 313-314 — Telegram Approval section
new SpendingLimitRule({ perTransaction: { amount: "100", token: "SOL" } }, store, chain)
new ApprovalGateRule({ above: { amount: "10", token: "SOL" } }, chain)
```

The actual constructors are:
- `SpendingLimitRule(config: SpendingLimitConfig)` -- 1 argument
- `RateLimitRule(config: RateLimitConfig)` -- 1 argument
- `ApprovalGateRule(config: ApprovalGateConfig)` -- 1 argument

These rules receive the `store` via `PolicyContext` at evaluation time, not at construction. Users copying these snippets will get TypeScript errors in strict mode, or the extra arguments will be silently ignored at runtime. This creates confusion and undermines trust in the documentation.

**Recommendation:**
Update all README code snippets to match the actual single-argument constructor signatures. The examples in `examples/` already use the correct API -- align README with those patterns.

---

### S7-02: README Telegram snippet uses non-null assertion without env var validation -- Severity: MEDIUM

**File:** `README.md` (lines 306-307)

**Description:**
The README's Telegram approval code snippet uses TypeScript non-null assertions on environment variables without any preceding validation:

```typescript
const telegram = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  ...
});
```

If a reader copies this pattern without adding their own validation, the `!` operator silently passes `undefined` as the token, which would cause runtime failures or send requests to an invalid Telegram API URL. In contrast, the actual `examples/telegram-approval/index.ts` properly validates both env vars upfront and exits with helpful instructions.

**Recommendation:**
Add a brief env-var check before the `TelegramApprovalBot` construction in the README snippet, or add a comment like `// Ensure these are set -- see examples/telegram-approval for validation`. At minimum, note that validation is omitted for brevity.

---

### S7-03: README Telegram snippet references undeclared `keypair` variable -- Severity: MEDIUM

**File:** `README.md` (line 320)

**Description:**
The Human Approval code snippet uses `new LocalSigner(keypair)` but `keypair` is never declared in the snippet. A reader copying this code block verbatim will get a compilation error.

```typescript
const wallet = new AgentWallet({
  signer: new LocalSigner(keypair),  // keypair is never declared
  chain,
  policy: engine,
  store,
  approval: telegram,
});
```

**Recommendation:**
Add `const keypair = Keypair.generate();` at the top of the snippet, with the appropriate import.

---

### S7-04: basic-transfer comment references unused SOLANA_PRIVATE_KEY env var -- Severity: LOW

**File:** `examples/basic-transfer/index.ts` (line 12)

**Description:**
The JSDoc header says "Set SOLANA_PRIVATE_KEY env var (base58 secret key) or it generates a fresh one," but the code unconditionally calls `Keypair.generate()` at line 34 and never reads `SOLANA_PRIVATE_KEY`. The comment is misleading -- it implies the example supports loading an existing key from the environment, which it does not.

This is actually good from a security perspective (generated keys are safer for examples), but the stale comment could confuse readers into thinking they need to export a private key.

**Recommendation:**
Remove the `SOLANA_PRIVATE_KEY` reference from the JSDoc header, or add code that optionally reads it. Given this is a demo, the safer approach is to simply remove the comment.

---

### S7-05: README LocalSigner snippet shows `fromSecretKey` without security warning -- Severity: LOW

**File:** `README.md` (lines 527-529)

**Description:**
The Signers section shows:

```typescript
const signer = new LocalSigner(Keypair.generate());
// or from a secret key
const signer2 = new LocalSigner(Keypair.fromSecretKey(secretKeyBytes));
```

While there is a warning blockquote below ("LocalSigner is for development and testing only"), the `fromSecretKey` example could encourage readers to embed key material in source code. The variable name `secretKeyBytes` is appropriately generic (not hardcoded), which is good.

The `LocalSigner` class file itself has the correct JSDoc warning: "WARNING: For development and testing only. The private key exists in process memory and can be extracted via heap dumps."

**Recommendation:**
This is acceptable as-is since the warning blockquote follows immediately. Consider adding a comment on the `fromSecretKey` line: `// Load from secure source -- never hardcode`.

---

### S7-06: E2E test `allowAllRule` is defined but never used -- Severity: INFO

**File:** `tests/e2e/agent-demo.test.ts` (line 31-34)

**Description:**
The `allowAllRule` mock is defined at the top of the test file but is never referenced in any test case. This is dead code. While not a security issue per se, unused security-related test infrastructure can create confusion about test coverage.

**Recommendation:**
Remove the unused `allowAllRule` definition, or add a test that uses it if there is an intended coverage gap.

---

### S7-07: E2E tests do not cover approval timeout scenario -- Severity: LOW

**File:** `tests/e2e/agent-demo.test.ts`

**Description:**
The approval flow tests cover three scenarios: approved, rejected, and below-threshold (skipped). However, there is no test for the **timeout** scenario where the approval channel returns `{ decision: "timeout" }`. In production, the `TelegramApprovalBot.waitForResponse()` returns a timeout result after the deadline expires. The `ApprovalGateRule` should treat timeout as DENY, and the e2e test suite should verify this behavior.

**Recommendation:**
Add a test case where the mock approval channel returns `{ decision: "timeout", ... }` and assert that the wallet returns `status: "denied"`.

---

### S7-08: Examples correctly use `Keypair.generate()` -- no hardcoded keys -- Severity: INFO (POSITIVE)

**File:** All 4 example files

**Description:**
All four examples use `Keypair.generate()` to create fresh keypairs. No example loads a private key from the environment or hardcodes key material. This is the correct pattern for example code.

- `examples/basic-transfer/index.ts` line 34: `Keypair.generate()`
- `examples/claude-agent/index.ts` line 54: `Keypair.generate()`
- `examples/policy-playground/index.ts`: No keypair needed (policy-only)
- `examples/telegram-approval/index.ts` line 80: `Keypair.generate()`

**Recommendation:** None -- this is correct.

---

### S7-09: Claude agent example validates ANTHROPIC_API_KEY before use -- Severity: INFO (POSITIVE)

**File:** `examples/claude-agent/index.ts` (lines 172-179)

**Description:**
The Claude agent example properly checks `process.env.ANTHROPIC_API_KEY` before proceeding and exits with clear instructions if it is not set. The error message includes a placeholder `sk-ant-...` which is safe (it is clearly a placeholder, not a real key).

**Recommendation:** None -- this is correct.

---

### S7-10: Telegram example validates env vars upfront with clear instructions -- Severity: INFO (POSITIVE)

**File:** `examples/telegram-approval/index.ts` (lines 38-59)

**Description:**
The Telegram approval example validates both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` at the top of the file, before any code runs. If either is missing, it prints a detailed multi-line setup guide and exits. The placeholder values in the error message (`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`) are clearly fake and safe.

**Recommendation:** None -- this is exemplary.

---

### S7-11: Package.json `files` field correctly restricts distribution -- Severity: INFO (POSITIVE)

**File:** `package.json` (lines 34-38)

**Description:**
The `files` array is explicitly set to `["dist", "README.md", "LICENSE"]`. This means only compiled JavaScript/TypeScript declarations, the README, and the LICENSE are included in the npm package. Source code, tests, examples, `.env` files, `implementation/` audit documents, and any other development artifacts are excluded.

The `prepublishOnly` script runs `npm run clean && npm run build`, ensuring that stale build artifacts are removed and a fresh build is produced before every publish.

The `.gitignore` correctly excludes `.env` and `.env.*` files.

**Recommendation:** None -- this is correct.

---

### S7-12: Policy engine enforces fail-closed -- tests accurately verify -- Severity: INFO (POSITIVE)

**File:** `tests/e2e/agent-demo.test.ts`, `src/policy/engine.ts`

**Description:**
The `PolicyEngine.evaluate()` wraps each `rule.evaluate()` in a try/catch block. If a rule throws, the engine produces a DENY decision with an audit trail (fail-closed). The e2e tests accurately verify:

- Spending limit denial (lines 258-282)
- Allowlist denial (lines 284-307)
- Rate limit denial (lines 309-339)
- Daily limit accumulation (lines 341-375)
- Circuit breaker open after consecutive denials (lines 518-549)
- Circuit breaker cooldown reset (lines 552-588)
- Circuit breaker counter reset on success (lines 590-633)
- Idempotency (lines 801-832)
- Audit hash chain integrity (lines 867-931)

The `PolicyEngine` constructor rejects empty rule arrays (line 22-26), preventing an accidentally-permissive engine.

**Recommendation:** None -- the security model is well-tested.

---

### S7-13: JSDoc comments are accurate on public APIs -- Severity: INFO (POSITIVE)

**File:** `src/core/wallet.ts`, `src/policy/engine.ts`, `src/policy/builder.ts`, `src/logging/audit.ts`, `src/signers/local.ts`, `src/approval/telegram.ts`

**Description:**
JSDoc comments on public APIs were reviewed for accuracy:

- **AgentWallet.execute()**: Correctly documents the full pipeline and references mutex serialization (S1-04), idempotency (S1-02), and validation (S1-09).
- **AgentWallet.handleToolCall()**: Correctly notes error sanitization (S5-04).
- **AgentWallet.getTransactionHistory()**: Correctly documents limit validation (S1-06).
- **PolicyEngine.evaluate()**: Correctly documents fail-closed behavior, per-rule timing, and early-exit on DENY.
- **PolicyEngine.getRules()**: Correctly notes frozen defensive copy (S5-05).
- **Policy.fromJSON()**: Correctly notes validation before construction.
- **Policy.toJSON()/getConfig()**: Correctly notes deep copy (structuredClone).
- **AuditLogger.log()**: Correctly documents circuit breaker behavior and hash chaining.
- **LocalSigner**: Correctly warns about development-only usage and heap dump risk.
- **TelegramApprovalBot**: Correctly notes token redaction in error messages (verified in `apiCall()` at lines 300, 308).
- **ApprovalGateRule**: Correctly documents fail-closed behavior for missing channel, rejection, timeout, and thrown exceptions.

No JSDoc comments were found to mislead about security properties.

**Recommendation:** None -- JSDoc is accurate.

---

### S7-14: LICENSE is standard MIT with correct copyright line -- Severity: INFO (POSITIVE)

**File:** `LICENSE`

**Description:**
The LICENSE file contains the standard MIT License text verbatim. The copyright line reads "Copyright (c) 2025 kova contributors" which is appropriate. The `package.json` also declares `"license": "MIT"`, matching the LICENSE file.

**Recommendation:** None -- this is correct.

---

### S7-15: Telegram bot token is redacted from error messages -- Severity: INFO (POSITIVE)

**File:** `src/approval/telegram.ts` (lines 300, 308)

**Description:**
The `TelegramApprovalBot.apiCall()` method replaces the bot token with `[REDACTED]` in both HTTP error and API error scenarios. This prevents the token from leaking into logs, error handlers, or being returned to the AI agent via the sanitized error path in `handleToolCall()`.

```typescript
const text = (await response.text()).slice(0, 200).replaceAll(this.token, "[REDACTED]");
const desc = (json.description ?? "unknown").replaceAll(this.token, "[REDACTED]");
```

**Recommendation:** None -- this is correct.

---

### S7-16: README `circuitBreaker: false` pattern could be copy-pasted unsafely -- Severity: LOW

**File:** `README.md` (lines 381-387)

**Description:**
The README shows how to disable the circuit breaker entirely:

```typescript
const walletNoCB = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: false,
});
```

While this is a legitimate configuration option, presenting it without a warning could encourage readers to disable the circuit breaker in production. The code comment says "Set to false to disable the circuit breaker entirely" but does not explain the security implications (runaway agent retries, infinite policy denial loops).

**Recommendation:**
Add a brief note or warning comment: `// WARNING: Disabling the circuit breaker removes protection against runaway agent behavior. Use with caution.`

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 1     |
| Medium   | 2     |
| Low      | 4     |
| Info     | 9     |

**Breakdown:**
- **1 High**: README code snippets use incorrect rule constructor signatures (S7-01)
- **2 Medium**: README Telegram snippet lacks env validation (S7-02), undeclared `keypair` variable (S7-03)
- **4 Low**: Stale SOLANA_PRIVATE_KEY comment (S7-04), fromSecretKey without inline warning (S7-05), missing approval timeout test (S7-07), circuitBreaker:false without warning (S7-16)
- **9 Info/Positive**: Generated keypairs (S7-08), ANTHROPIC_API_KEY validation (S7-09), Telegram env validation (S7-10), clean npm pack surface (S7-11), fail-closed tests (S7-12), accurate JSDoc (S7-13), correct LICENSE (S7-14), token redaction (S7-15), unused test helper (S7-06)

## Verdict

**PASS WITH RECOMMENDATIONS**

The SDK's security model is sound. All four examples follow safe patterns (generated keys, env validation, devnet defaults, conservative policies). The e2e tests accurately reflect the fail-closed security model with circuit breaker, audit integrity, and idempotency coverage. The npm pack surface is clean. JSDoc is accurate and does not mislead about security properties.

The primary issue is that README code snippets have incorrect API signatures (S7-01) which will cause TypeScript compilation errors for users who copy them directly. This is a **documentation correctness** issue that should be fixed before publishing. The two Medium findings (S7-02, S7-03) are also README-specific and should be addressed to ensure copy-paste safety.

No security vulnerabilities were found in the runtime code. The examples themselves are well-written and security-conscious.
