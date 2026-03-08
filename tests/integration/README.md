# Integration Tests

This directory contains integration tests for kova-wallet. Unlike unit tests, integration
tests exercise real I/O: file system persistence, network calls, and external services.

---

## What integration tests cover

| Test file                         | What it exercises                                                      |
|-----------------------------------|------------------------------------------------------------------------|
| `sqlite-persistence.test.ts`      | SqliteStore persists data across process-like restarts (close + reopen)|
| `store-timeout.test.ts`           | StoreWithTimeout wrapper enforces per-operation deadlines              |
| `circuit-breaker-multi-instance.test.ts` | Multi-instance detection in CircuitBreaker (same store, two instances) |
| _(future)_ `solana-devnet.test.ts`| Solana devnet RPC: transfers, balance checks, swap quotes (Jupiter)    |
| _(future)_ `telegram-approval.test.ts`  | Telegram approval channel end-to-end round trip                  |

### Solana devnet / Jupiter API (future)
- Confirms that `SolanaAdapter` can connect to a real Solana devnet RPC node.
- Confirms that Jupiter swap quote API returns a parseable response.
- These tests require a funded devnet keypair and will transfer real (devnet) SOL.

### SQLite persistence
- Creates a `SqliteStore` with a real temp-file path (not `:memory:`).
- Writes values, counters, and list entries, then calls `close()`.
- Opens a **new** `SqliteStore` instance pointing at the same file.
- Asserts all data is still readable — this exercises the WAL flush and schema migration.
- Also verifies that spending-limit counters (e.g., `spending:daily:sol`) survive restart,
  which is critical for budget enforcement across agent process restarts.

### StoreWithTimeout
- Wraps any `Store` implementation with per-operation timeouts.
- Tests that normal operations complete without error when the underlying store is fast.
- Tests that a hung store (simulated with a never-resolving promise) causes `StoreTimeoutError`
  to be thrown rather than blocking indefinitely.
- Tests that the timeout duration is configurable per-instance.

### CircuitBreaker multi-instance detection
- Creates two `CircuitBreaker` instances that share the same `MemoryStore`.
- Verifies that the second `initialize()` throws when `failOnMultiInstance: true` (the default).
- Verifies that setting `failOnMultiInstance: false` allows both instances to coexist (with a
  process warning), which is the expected behavior when distributed locking is in place.

### Telegram approval channel (future)
- Sends a real Telegram message via the Bot API and reads the reply.
- Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` environment variables.

---

## How to run

```bash
# Run only integration tests
npm run test:integration

# Run all tests (unit + integration)
npm test
```

### Required environment variables

| Variable              | Required for              | Description                                          |
|-----------------------|---------------------------|------------------------------------------------------|
| `KOVA_ALLOW_MEMORY_STORE` | All tests              | Set to `1` — enables MemoryStore outside production  |
| `SOLANA_RPC_URL`      | Solana devnet tests        | e.g. `https://api.devnet.solana.com`                 |
| `SOLANA_PRIVATE_KEY`  | Solana devnet tests        | Base58 private key of a funded devnet wallet         |
| `TELEGRAM_BOT_TOKEN`  | Telegram approval tests    | Bot token from @BotFather                            |
| `TELEGRAM_CHAT_ID`    | Telegram approval tests    | Chat ID that the bot can send messages to            |

The SQLite persistence, StoreWithTimeout, and CircuitBreaker multi-instance tests
**do not** require any environment variables beyond `KOVA_ALLOW_MEMORY_STORE`.

---

## Why integration tests are separate from unit tests

| Concern       | Unit tests                        | Integration tests                           |
|---------------|-----------------------------------|---------------------------------------------|
| Speed         | Milliseconds per test             | Seconds per test (I/O, network round trips) |
| Isolation     | Fully isolated, no real I/O       | Use real file system, real network          |
| Credentials   | None needed                       | May require API keys, funded wallets        |
| Determinism   | Deterministic (mocked time, store)| May depend on external service availability |
| CI policy     | Always run in CI                  | Run only in nightly or release pipelines    |

Running slow, credential-dependent tests on every commit would create false failures
from transient network issues and would expose credentials in standard CI pipelines.
Keeping them separate lets the unit test suite remain a fast, dependency-free signal.
