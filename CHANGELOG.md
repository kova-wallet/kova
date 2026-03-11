# Changelog

## 2.0.0 (2026-03-11)

Major release with new oracle price feeds, redesigned approval system, enhanced Redis store, and significant security hardening.

### Breaking Changes

- **Telegram approval removed** — `TelegramApprovalBot` has been deleted. Migrate to `WebhookApprovalChannel` or `CallbackApprovalChannel`.
- **`ApprovalRequest.intentHash` now required** — enables TOCTOU protection; approval requests are cryptographically bound to specific intents.
- **`ChainAdapter.verifyTransactionIntegrity()` now required** — adapters must implement this method or throw a descriptive error.
- **Circuit breaker opt-out changed** — `circuitBreaker: false` is deprecated. Use `{ dangerouslyDisable: true }` for explicit opt-out.
- **Auth token required by default** — provide `authToken` or set `dangerouslyDisableAuth: true`.
- **Verbose errors gated in production** — `verboseErrors: true` in production requires `dangerouslyAllowVerboseErrorsInProduction: true`.
- **`PolicyEngine` removed from public exports** — use the `Policy` builder instead.
- **Swap verification methods removed** — `getPreSwapSnapshot()` and `verifySwapOutput()` removed from `ChainAdapter` interface.

### New Features

- **Pyth price oracle** — real-time Solana price feeds via `createPythPriceProvider()` with mainnet and devnet feed addresses.
- **Consensus price provider** — multi-oracle agreement via `createConsensusProvider()` for robust USD valuation with fallback support.
- **Webhook approval channel** — HTTP webhook-based approval with HMAC-SHA256 request signing, SSRF protection, and configurable timeouts.
- **Callback approval channel** — developer-provided callbacks for custom approval flows (Slack, Discord, email, push notifications, etc.).
- **Enhanced Redis store** — AES-256-GCM encryption at rest, HMAC-SHA256 counter integrity, optional TLS enforcement, and key prefix validation.
- **Transaction result warnings** — non-fatal `warnings` field on all `TransactionResult` statuses for tracking non-blocking issues.
- **Self-approval prevention** — `requestedByUserId` field on `ApprovalRequest` prevents users from approving their own transactions.

### Security

- **Store operation timeouts** — all store operations wrapped with configurable timeout (default 5s) to prevent indefinite hangs.
- **Timing side-channel resistance** — `minEvaluationTimeMs` pads policy evaluation time to mask rule count and denial source.
- **Single-process lock enforcement** — store-based advisory lock prevents concurrent access TOCTOU races.
- **Enhanced control character filtering** — expanded to include soft hyphens, zero-width joiners, RTL marks, and Unicode tag characters.
- **Prototype pollution hardening** — expanded blocklist and 20-depth recursion limits in canonicalization and key stripping.
- **Audit entry HMAC** — independent per-entry HMAC for standalone verification without relying on hash chain.
- **Audit checkpoints** — checkpoint hashes every 1000 entries for partial audit trail recovery.
- **HMAC key validation** — emits security warning when no HMAC key is provided.
- **Destroyed store tracking** — RedisStore prevents operations after `destroy()`.

### Improvements

- Amount normalization strips trailing zeros for consistent hashing.
- Configurable history retrieval with 1000-entry max limit.
- Audit filter support to reduce log volume (DENY events cannot be excluded).
- Hash chain break detection continues from next checkpoint for partial recovery.
- Policy context now includes frozen `clearList` method binding.

### Deprecated

- `@kova/wallet@1.0.0` — deprecated on npm. Upgrade to 2.0.0.

---

## 1.0.0 (2026-03-08)

Initial public release of the Kova wallet SDK.

### Features

- **AgentWallet** — policy-constrained wallet for autonomous AI agents with mutex-based execution, idempotency keys, and fail-closed error handling
- **Policy engine** — composable rules evaluated in order: spending limits (per-tx, daily, weekly, monthly), rate limits, allowlists, time windows, and approval gates
- **USD-denominated spending limits** — with pluggable price oracle support
- **Spending limit rollback** — counters are rolled back on broadcast/confirmation failure
- **Approval gates** — human-in-the-loop approval via Telegram (extensible to other channels)
- **Signers** — LocalSigner (dev/test only), MpcSigner (custom MPC providers), TurnkeyProvider (Turnkey integration)
- **Stores** — MemoryStore (dev/test), SqliteStore (production), PrefixedStore (multi-wallet isolation)
- **Chain adapters** — Solana (transfers, SPL tokens, swaps via Jupiter, staking, priority fees, DNS pinning)
- **LLM tool adapters** — pre-built tool definitions for Anthropic, OpenAI, and LangChain formats
- **Circuit breaker** — automatic shutdown on anomalous transaction patterns with multi-instance detection
- **Audit logging** — tamper-evident hash-chained audit trail with HMAC-protected counters
- **Input validation** — comprehensive validation at all public API boundaries

### Security

- Fail-closed policy evaluation (store errors result in DENY)
- Intent hash binding for approval requests
- Prototype pollution protection in policy deserialization
- Control character stripping in metadata fields
- Counter HMAC integrity verification
- LocalSigner blocked in production environments
