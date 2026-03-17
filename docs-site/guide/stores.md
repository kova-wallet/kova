# Stores

::: info What you'll learn
- Why the SDK needs a persistence layer and what happens without one
- The 7-method Store interface that all backends implement
- When to use `MemoryStore` (dev) vs `SqliteStore` (single-server) vs `RedisStore` (multi-server)
- How to implement a custom Store for DynamoDB, Postgres, or other backends
- Why `increment()` must be atomic for spending limit safety
:::

A Store is the SDK's internal database -- it remembers how much your agent has spent, how many transactions it has sent, and what happened in the past, so that safety rules work correctly even after your application restarts.

Stores provide pluggable persistence for the SDK's internal state. The interface is deliberately minimal (7 methods) to make custom adapters trivial to implement.

## Which Store Should I Use?

| Scenario | Recommended Store | Why |
|---|---|---|
| **Unit tests / integration tests** | `MemoryStore` | Fast, no setup, no cleanup needed. Data resets automatically. |
| **Local development / prototyping** | `MemoryStore` | Quick to get started. Spending limits reset on restart, which is fine during development. |
| **Production (single server)** | `SqliteStore` | Data persists across restarts. Spending counters, rate limits, and audit logs survive crashes. |
| **Production (multiple servers)** | `RedisStore` | Shared state across instances. Natively atomic operations. Install `ioredis` and go. |
| **Serverless / edge functions** | Custom store (DynamoDB, Upstash Redis, etc.) | Persistence without a local filesystem. Implement the 7-method `Store` interface. |

::: tip QUICK RULE OF THUMB
If you are just getting started or running tests, use `MemoryStore`. If you are deploying to production on a single server, use `SqliteStore`. If you need multi-process or multi-server deployments, use `RedisStore`. The only difference is whether your safety data survives restarts and whether it is shared across processes.
:::

::: warning Floating-Point Precision (ARCH-08)
`MemoryStore` counters use JavaScript IEEE 754 doubles, which can accumulate drift over many increments (e.g., after thousands of small transactions). For high-precision accounting or sub-cent accuracy, prefer `SqliteStore` (native numeric types) or `RedisStore` (`INCRBYFLOAT`). The drift is mitigated by rounding to 12 decimal places and using BigInt comparisons, but is a known limitation for extremely high-frequency agents.
:::

## Why the SDK Needs a Store

The store is not for your application data -- it is for Kova's own safety mechanisms. The SDK persists five categories of internal state:

| State | Purpose | What Happens Without Persistence |
|-------|---------|----------------------------------|
| **Spending limit counters** | Tracks how much the agent has spent per day/week/month | Restarting the process resets the counter to zero, so the agent can exceed its configured budget |
| **Rate limit counters** | Tracks how many transactions the agent has executed in the current time window | A restart clears the count, allowing the agent to burst past the rate limit |
| **Circuit breaker state** | Locks the wallet after consecutive policy denials | A restart clears the lockdown, letting the agent immediately retry denied transactions |
| **Audit log** | A hash-chained, tamper-evident record of every transaction attempt and policy decision | You lose the forensic trail needed for debugging and compliance |
| **Idempotency cache** | Prevents duplicate execution if the same intent is submitted twice | A crash followed by a retry could execute the same transfer twice |

::: warning
In development, `MemoryStore` is fine -- your agent is short-lived and you are not worried about enforcing limits across restarts. In production, you **must** use a persistent store like `SqliteStore` or `RedisStore` so that these safety guarantees actually hold. Without persistence, a simple process restart could let your agent blow past its spending limits.
:::

## Store Interface

```typescript
// Import the Store type from the kova SDK.
// Store is the interface that all persistence backends must implement.
import type { Store } from "@kova/wallet";
```

```typescript
// The Store interface defines seven methods that any persistence backend must provide.
// All methods are async (return Promises) so they work with both in-memory and
// remote/disk-based backends without changing the calling code.
interface Store {
  /** Get a value by key. Returns null if not found or expired. */
  // Used by the SDK to retrieve persisted state such as spending counters,
  // rate limit windows, circuit breaker status, and idempotency cache entries.
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL (in seconds). */
  // Stores a key-value pair. The optional ttlSeconds parameter allows the SDK
  // to auto-expire entries (e.g., rate limit counters that reset every hour).
  // If ttlSeconds is omitted or undefined, the entry persists indefinitely.
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Set a value only if the key does not already exist. Returns true if set, false if key existed. */
  // Used for idempotency locks and other compare-and-set operations where
  // you need to ensure only the first caller wins.
  setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean>;

  /** Atomically increment a numeric value. Returns the new value.
      Creates the key with the given amount if it does not exist. */
  // Critical for spending and rate limit tracking. Atomicity is required to
  // prevent race conditions when multiple concurrent execute() calls try to
  // update the same counter simultaneously. A non-atomic implementation could
  // allow the agent to exceed its configured budget.
  increment(key: string, amount: number): Promise<number>;

  /** Append an entry to a list (for transaction logs). */
  // Used by the audit logging system to add new log entries to a persistent,
  // ordered list. Each entry is a JSON-serialized audit record.
  append(key: string, value: string): Promise<void>;

  /** Get the most recent N entries from a list, newest first. */
  // Retrieves recent audit log entries for inspection or display.
  // Returns entries in reverse chronological order (newest first).
  getRecent(key: string, count: number): Promise<string[]>;

  /** Clear all entries from a list. */
  // Optional method for removing all entries from a specific list key.
  clearList(key: string): Promise<void>;
}
```

All methods return `Promise` -- even in-memory implementations use `async` for interface consistency.

::: tip WHAT IS "ATOMICITY"?
Atomicity means an operation either fully completes or does not happen at all -- there is no in-between state. For the `increment()` method, this means that if two transactions try to update a spending counter at the same instant, each one sees the other's update. Without atomicity, both transactions could read "8 SOL spent," both add 2, and both write "10 SOL" -- allowing 12 SOL total spending under a 10 SOL limit. This is the same concept behind database transactions and compare-and-swap operations.
:::

## MemoryStore

In-memory store for development and testing. All data is lost when the process exits.

```typescript
// Import the built-in MemoryStore from kova. No external dependencies are needed.
import { MemoryStore } from "@kova/wallet";

// Create an in-memory store instance. All data lives in JavaScript objects/maps
// within the current Node.js process. Fast and simple, but nothing survives a restart.
const store = new MemoryStore(); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
```

::: warning Production Safety
`MemoryStore` is designed for development and testing. It will throw an error in all environments unless the `KOVA_ALLOW_MEMORY_STORE=1` environment variable is set. For production deployments, use `SqliteStore` with encryption instead, which provides persistence and crash recovery.
:::

### Characteristics

- **TTL expiration**: Checked lazily on read. Expired keys are deleted on access.
- **Atomicity**: `increment()` is synchronous within the async wrapper, so there is no race condition between read and write.
- **Lists**: Stored as in-memory arrays. `getRecent()` returns entries newest-first.
- **Max list size**: Lists are capped at 100,000 entries. When the limit is reached, the oldest entries are evicted (FIFO). This prevents unbounded memory growth from audit logs and transaction history.
- **No persistence**: Data does not survive process restarts.

### clear()

Reset all data. Useful in test suites.

```typescript
// Wipe all keys, values, and lists from the in-memory store.
// Commonly called in beforeEach() or afterEach() hooks in test suites
// to ensure a clean slate between test cases.
store.clear();
```

### Size Limits

MemoryStore enforces hard limits to prevent unbounded memory growth:

| Limit | Value | Description |
|-------|-------|-------------|
| `MAX_LIST_SIZE` | 100,000 | Maximum entries per list (e.g., audit log). Oldest entries are evicted FIFO |
| `MAX_KEY_LENGTH` | 512 | Maximum length of a store key in characters |
| `MAX_VALUE_LENGTH` | 1,000,000 | Maximum length of a single value in characters (~1 MB) |

::: tip Memory budgeting
Estimate memory usage as (number of list keys) x MAX_LIST_SIZE x (average entry size). For production with large audit logs, prefer `SqliteStore` which writes to disk.
:::

### When to Use

- Unit tests and integration tests
- Local development and prototyping
- Short-lived scripts or one-off agent runs

::: warning
Do **not** use `MemoryStore` in production. Spending counters and rate limits will reset on every restart, allowing the agent to exceed configured limits.
:::

## SqliteStore

Persistent store using `better-sqlite3`. Data survives process restarts.

```typescript
// Import SqliteStore, which uses the better-sqlite3 npm package under the hood.
// better-sqlite3 is a synchronous, native SQLite binding for Node.js.
import { SqliteStore } from "@kova/wallet";

// Create a persistent store backed by an SQLite database file on disk.
// The file "wallet-data.db" will be created automatically if it doesn't exist.
// All SDK state (spending counters, rate limits, audit logs, etc.) will be
// written to this file and survive process restarts.
const store = new SqliteStore({ path: "./wallet-data.db" });
```

::: tip WHAT IS SQLITE?
SQLite is a lightweight database engine that stores everything in a single file on disk. Unlike PostgreSQL or MySQL, it requires no separate server process -- it runs directly inside your Node.js application. It is the most widely deployed database in the world (used in every smartphone, most browsers, and many embedded systems). The `better-sqlite3` npm package provides fast, synchronous access to SQLite from Node.js.
:::

### SqliteStoreConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | Yes | Path to the SQLite database file |
| `allowedDirectories` | `string[]` | No | Additional parent directories allowed for the database file. By default only the current working directory is allowed |
| `pragmas` | `string[]` | No | PRAGMA statements executed after opening the database. Used for SQLCipher encryption |
| `requireEncryption` | `boolean` | No | When `true` (default), the constructor throws if no encryption pragma is provided. Set to `false` for development |
| `hmacKey` | `string` | No | Hex-encoded 32-byte HMAC key for counter integrity. Without a persistent key, counter HMACs become invalid after restart |
| `encryptionKey` | `Buffer` | No | AES-256-GCM key (32 bytes) for application-level encryption of all stored values |

```typescript
import { SqliteStore } from "@kova/wallet";

// Production SqliteStore with application-level encryption.
const store = new SqliteStore({
  path: "./wallet-data.db",
  // AES-256-GCM encryption for all stored values.
  encryptionKey: Buffer.from(process.env.STORE_ENCRYPTION_KEY!, "hex"),
  // HMAC key for counter integrity across restarts.
  hmacKey: process.env.STORE_HMAC_KEY!,
  // Not using SQLCipher -- app-level encryption instead.
  requireEncryption: false,
});
```

### Characteristics

- **WAL mode**: Write-Ahead Logging is enabled for better concurrent read performance.
- **Busy timeout**: Set to 5000ms to handle concurrent access gracefully.
- **TTL expiration**: Checked lazily on read, matching `MemoryStore` behavior.
- **Atomicity**: `increment()` uses an SQLite transaction for true atomic read-modify-write.
- **Max list size**: Lists are capped at 100,000 entries, matching `MemoryStore`. Excess entries are evicted oldest-first using a transactional `DELETE ... ORDER BY id ASC LIMIT ?` query.
- **Tables**: Two tables are created automatically:
  - `kv` -- Key-value pairs with optional TTL (`key TEXT PRIMARY KEY`, `value TEXT`, `expires_at INTEGER`)
  - `lists` -- Append-only list entries with auto-increment ID (`key TEXT`, `value TEXT`, `created_at INTEGER`, `id INTEGER PRIMARY KEY AUTOINCREMENT`)

> **Worker thread**: All synchronous better-sqlite3 operations are offloaded to a dedicated worker thread, keeping the main event loop unblocked. Worker health checks and backpressure (max 1,000 pending requests) prevent resource exhaustion.

### In-Memory Mode

For tests that need `SqliteStore` behavior without touching the filesystem:

```typescript
// Use the special ":memory:" path to create an in-memory SQLite database.
// This gives you the same SQL-based behavior (WAL mode, atomic transactions)
// as a file-backed store, but without writing anything to disk.
// Ideal for integration tests that need to verify SqliteStore-specific behavior.
const store = new SqliteStore({ path: ":memory:" });
```

### close()

Close the database connection. Call this when shutting down.

```typescript
// Gracefully close the SQLite database connection.
// This flushes any pending WAL writes and releases the file lock.
// Always call this during application shutdown (e.g., in a SIGTERM handler)
// to prevent data corruption or locked database files.
store.close();
```

::: warning
Always call `store.close()` when your application shuts down. Failing to close the connection can leave the database file locked and cause data corruption on the next startup. A common pattern is to register a shutdown handler:
```typescript
process.on("SIGTERM", () => { store.close(); process.exit(0); });
```
:::

### clear()

Delete all data from both tables. Useful for testing.

```typescript
// Delete all rows from both the "kv" and "lists" tables in the SQLite database.
// This resets all persisted SDK state (spending counters, audit logs, etc.)
// without deleting the database file itself. Useful in test teardown.
store.clear();
```

## RedisStore

Redis-backed store for multi-process and multi-server production deployments. Requires the `ioredis` optional peer dependency.

```bash
# Install ioredis (optional peer dependency -- only needed if you use RedisStore)
npm install ioredis
```

```typescript
// Import the built-in RedisStore from kova. Requires ioredis to be installed.
import { RedisStore } from "@kova/wallet";

// Connect to a Redis server with a URL.
const store = new RedisStore({ url: "redis://localhost:6379" });

// Or connect with default settings (localhost:6379):
const store = new RedisStore();
```

### RedisStoreConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client` | `Redis` (ioredis instance) | No | An existing ioredis client. When provided, RedisStore uses this connection and does **not** close it on `disconnect()` -- the caller owns the lifecycle. Use this for Sentinel, Cluster, or custom connection setups. |
| `url` | `string` | No | Redis connection URL (e.g., `"redis://localhost:6379"`, `"rediss://user:pass@host:6380/0"`). Ignored if `client` is provided. Defaults to `localhost:6379`. |
| `keyPrefix` | `string` | No | Prefix applied to all Redis keys for application-level namespacing (e.g., `"kova:"`). Separate from `PrefixedStore`'s per-wallet prefix -- you can use both. |
| `listPrefix` | `string` | No | Internal prefix for list keys to avoid collisions with KV keys. Default: `"list:"`. |

```typescript
import { RedisStore } from "@kova/wallet";

// Production RedisStore with an application-level key prefix.
const store = new RedisStore({
  url: process.env.REDIS_URL!,
  // All keys are prefixed with "kova:" to avoid collisions with other
  // applications sharing the same Redis instance.
  keyPrefix: "kova:",
});
```

#### Bring Your Own Client

For advanced setups (Sentinel, Cluster, custom retry logic), pass an existing ioredis client:

```typescript
import Redis from "ioredis";
import { RedisStore } from "@kova/wallet";

// Create an ioredis Cluster client for high availability.
const cluster = new Redis.Cluster([
  { host: "redis-1.example.com", port: 6379 },
  { host: "redis-2.example.com", port: 6379 },
]);

// RedisStore wraps the existing client. It will NOT call quit() on disconnect().
const store = new RedisStore({ client: cluster });
```

### Characteristics

- **TTL expiration**: Handled natively by Redis. No lazy expiration needed -- Redis deletes keys automatically when their TTL expires.
- **Atomicity**: `increment()` uses Redis `INCRBYFLOAT`, which is a single atomic command. Safe for concurrent multi-process access without any application-level locking.
- **Lists**: Uses `RPUSH` for appending and `LRANGE` for retrieval. Lists are automatically trimmed to 100,000 entries via a pipelined `LTRIM` after each append.
- **Sub-second TTL**: Uses `PX` (milliseconds) for TTL precision, supporting fractional-second TTLs.
- **KV/List isolation**: List keys are stored under a `list:` prefix internally, so a KV key `"mykey"` and a list key `"mykey"` do not collide in Redis.

### disconnect()

Close the Redis connection. Call this when shutting down.

```typescript
// Gracefully close the Redis connection.
// Only closes the connection if RedisStore created it (i.e., you passed
// a URL, not a client). If you passed your own ioredis client, you are
// responsible for closing it yourself.
await store.disconnect();
```

```typescript
// Recommended shutdown pattern:
process.on("SIGTERM", async () => {
  await store.disconnect();
  process.exit(0);
});
```

### When to Use

- Production deployments with multiple server instances or processes
- Kubernetes / container deployments where pods share state
- Any scenario where `SqliteStore`'s single-process limitation is a blocker

::: tip
`RedisStore` is the recommended store for production multi-server deployments. Every Store method maps directly to a native Redis command, so there is no overhead from application-level locking or worker threads.
:::

## Comparison

| Feature | MemoryStore | SqliteStore | RedisStore |
|---------|-------------|-------------|------------|
| Persistence | None | File-based | Redis server |
| TTL Support | Yes (lazy) | Yes (lazy) | Yes (native) |
| Atomic increment | Yes (sync) | Yes (transaction) | Yes (INCRBYFLOAT) |
| Concurrent access | Single process | Single process (WAL) | Multi-process / multi-server |
| Setup | None | Requires `better-sqlite3` | Requires `ioredis` + Redis server |
| Use case | Dev / Testing | Production (single server) | Production (multi-server) |
| Data after restart | Lost | Preserved | Preserved |

## Implementing a Custom Store

To integrate with DynamoDB, Postgres, or any other backend, implement the 7-method `Store` interface. See the [Building a Custom Store Adapter](/tutorials/custom-store) tutorial for a step-by-step walkthrough.

::: tip
The key design constraint for custom stores is that `increment()` must be **atomic**. A non-atomic read-then-write implementation could allow concurrent `execute()` calls to exceed spending limits. Use database transactions or conditional writes to ensure atomicity.
:::

### Using a Store

```typescript
// Import all the core Kova components needed to wire up a wallet.
import { AgentWallet, PolicyEngine, RedisStore } from "@kova/wallet";

// Create a RedisStore instance pointing to your Redis server.
// In production, this would typically be a Redis Sentinel or Cluster URL.
const store = new RedisStore({ url: "redis://localhost:6379" });

// Create a PolicyEngine with your policy rules and the Redis-backed store.
// The engine will use the store to persist spending counters, rate limit
// windows, and circuit breaker state across process restarts.
const engine = new PolicyEngine(rules, store);

// Create the AgentWallet, passing the same store instance.
// Sharing the same store between PolicyEngine and AgentWallet ensures that
// spending limits, audit logs, and idempotency caches all read from and
// write to the same Redis database -- keeping all safety state consistent.
const wallet = new AgentWallet({
  signer,   // The key-signing backend (e.g., LocalSigner, VaultSigner)
  chain,    // The chain adapter (e.g., SolanaAdapter) for submitting transactions
  policy: engine, // The policy engine that enforces spending/rate limits
  store,    // The persistence backend shared with the policy engine
});
```

The same `Store` instance is shared between the `PolicyEngine` and `AgentWallet`. This ensures spending counters, rate limits, and audit logs all use the same persistence backend.

## Common Mistakes

**1. Using `MemoryStore` in production.**
Spending limits reset on every process restart, letting the agent spend beyond configured limits. Always use `SqliteStore` or `RedisStore` in production.

**2. Non-atomic `increment()` in custom stores.**
If your custom store implements `increment()` as a read-then-write (instead of an atomic operation), concurrent `execute()` calls can read the same stale value and both increment it, allowing the agent to exceed spending limits. Use database transactions, Redis `INCRBYFLOAT`, or compare-and-swap to ensure atomicity.

**3. Not sharing the store between `PolicyEngine` and `AgentWallet`.**
The policy engine and wallet must use the same store instance. If they use different stores, spending counters and audit logs will be out of sync.

## See Also

- [SpendingLimitRule](/guide/rules/spending-limit) -- uses the store to track spending counters with TTL-based rolling windows
- [RateLimitRule](/guide/rules/rate-limit) -- uses the store to track transaction frequency counters
- [Signers](/guide/signers) -- the key-management component that pairs with stores to form the wallet infrastructure
- [Chain Adapters](/guide/chain-adapters) -- the blockchain communication layer that completes the wallet architecture
