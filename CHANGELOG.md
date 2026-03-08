# Changelog

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

### Known Limitations

- Single-instance only (circuit breaker enforces this)
- Clock-based TTL enforcement (no monotonic clock)
- No built-in authentication layer (must be enforced at transport level)
- Store operation timeouts not yet implemented
- Solana ALT resolution for swaps not yet implemented
