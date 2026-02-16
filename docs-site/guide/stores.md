# Stores

A Store is the SDK's internal database -- it remembers how much your agent has spent, how many transactions it has sent, and what happened in the past, so that safety rules work correctly even after your application restarts.

Stores provide pluggable persistence for the SDK's internal state. The interface is deliberately minimal (5 methods) to make custom adapters trivial to implement.

## Which Store Should I Use?

| Scenario | Recommended Store | Why |
|---|---|---|
| **Unit tests / integration tests** | `MemoryStore` | Fast, no setup, no cleanup needed. Data resets automatically. |
| **Local development / prototyping** | `MemoryStore` | Quick to get started. Spending limits reset on restart, which is fine during development. |
| **Production (single server)** | `SqliteStore` | Data persists across restarts. Spending counters, rate limits, and audit logs survive crashes. |
| **Production (multiple servers)** | Custom `RedisStore` | Shared state across instances. See the custom store example below. |
| **Serverless / edge functions** | Custom store (DynamoDB, Upstash Redis, etc.) | Persistence without a local filesystem. Implement the 5-method `Store` interface. |

::: tip QUICK RULE OF THUMB
If you are just getting started or running tests, use `MemoryStore`. If you are deploying to production, use `SqliteStore` (or a custom store for multi-server setups). The only difference is whether your safety data survives restarts.
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
In development, `MemoryStore` is fine -- your agent is short-lived and you are not worried about enforcing limits across restarts. In production, you **must** use a persistent store like `SqliteStore` so that these safety guarantees actually hold. Without persistence, a simple process restart could let your agent blow past its spending limits.
:::

## Store Interface

```typescript
// Import the Store type from the kova SDK.
// Store is the interface that all persistence backends must implement.
import type { Store } from "kova";
```

```typescript
// The Store interface defines five methods that any persistence backend must provide.
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
import { MemoryStore } from "kova";

// Create an in-memory store instance. All data lives in JavaScript objects/maps
// within the current Node.js process. Fast and simple, but nothing survives a restart.
const store = new MemoryStore();

// IMPORTANT: If NODE_ENV=production, MemoryStore will throw unless you
// explicitly opt in with dangerouslyAllowInProduction:
const prodStore = new MemoryStore({ dangerouslyAllowInProduction: true });
```

::: warning Production Safety
`MemoryStore` is designed for development and testing. When `NODE_ENV=production`, it will throw an error unless `{ dangerouslyAllowInProduction: true }` is passed. For production deployments, use `SqliteStore` with encryption instead, which provides persistence and crash recovery.
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
import { SqliteStore } from "kova";

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
| `path` | `string` | Yes | Path to the SQLite database file. Use `":memory:"` for in-memory testing. |

### Characteristics

- **WAL mode**: Write-Ahead Logging is enabled for better concurrent read performance.
- **Busy timeout**: Set to 5000ms to handle concurrent access gracefully.
- **TTL expiration**: Checked lazily on read, matching `MemoryStore` behavior.
- **Atomicity**: `increment()` uses an SQLite transaction for true atomic read-modify-write.
- **Max list size**: Lists are capped at 100,000 entries, matching `MemoryStore`. Excess entries are evicted oldest-first using a transactional `DELETE ... ORDER BY id ASC LIMIT ?` query.
- **Tables**: Two tables are created automatically:
  - `kv` -- Key-value pairs with optional TTL (`key TEXT PRIMARY KEY`, `value TEXT`, `expires_at INTEGER`)
  - `lists` -- Append-only list entries with auto-increment ID (`key TEXT`, `value TEXT`, `created_at INTEGER`, `id INTEGER PRIMARY KEY AUTOINCREMENT`)

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

## Comparison

| Feature | MemoryStore | SqliteStore |
|---------|-------------|-------------|
| Persistence | None | File-based |
| TTL Support | Yes (lazy) | Yes (lazy) |
| Atomic increment | Yes (sync) | Yes (transaction) |
| Concurrent access | Single process | Single process (WAL) |
| Setup | None | Requires `better-sqlite3` |
| Use case | Dev / Testing | Production |
| Data after restart | Lost | Preserved |

## Implementing a Custom Store

To integrate with Redis, DynamoDB, or any other backend, implement the 5-method `Store` interface:

```typescript
// Import the Store type that our custom class must implement.
import type { Store } from "kova";
// Import the ioredis client library for connecting to a Redis server.
import Redis from "ioredis";

// A custom Store implementation backed by Redis.
// Redis is ideal for production deployments because it provides:
// - Native atomic increment (INCRBYFLOAT)
// - Built-in TTL support (the EX flag on SET)
// - High availability via Redis Sentinel or Cluster
// - Shared state across multiple application instances
export class RedisStore implements Store {
  // The ioredis client instance used for all Redis operations.
  private readonly client: Redis;
  // Prefix added to list keys to avoid collisions with scalar key-value entries.
  // For example, a list key "audit:log" becomes "list:audit:log" in Redis.
  private readonly listPrefix = "list:";

  // Initialize the Redis client with a connection URL (e.g., "redis://localhost:6379").
  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }

  // Retrieve a value by key. Redis returns null automatically if the key
  // does not exist or has expired (Redis handles TTL expiration natively).
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  // Store a key-value pair, optionally with a TTL in seconds.
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      // "EX" tells Redis to automatically expire (delete) this key
      // after ttlSeconds. Used for rate limit windows and idempotency cache entries.
      await this.client.set(key, value, "EX", ttlSeconds);
    } else {
      // No TTL -- the key persists until explicitly deleted.
      await this.client.set(key, value);
    }
  }

  // Atomically increment a numeric value stored at the given key.
  // Redis INCRBYFLOAT is a single atomic operation, which is critical
  // for spending limit tracking -- concurrent execute() calls cannot
  // read a stale value and both write the same incremented result.
  async increment(key: string, amount: number): Promise<number> {
    // Redis INCRBYFLOAT handles atomic increment
    const result = await this.client.incrbyfloat(key, amount);
    // INCRBYFLOAT returns a string representation; convert to a number.
    return parseFloat(result);
  }

  // Append a new entry to the head of a Redis list.
  // Used by the audit logging system to record each transaction attempt.
  async append(key: string, value: string): Promise<void> {
    // lpush inserts at the head (left) of the list, making the newest
    // entry always at index 0. The listPrefix avoids key collisions
    // with scalar values stored via set().
    await this.client.lpush(this.listPrefix + key, value);
  }

  // Retrieve the most recent N entries from a list, newest first.
  async getRecent(key: string, count: number): Promise<string[]> {
    // Guard against invalid count values.
    if (count <= 0) return [];
    // Because lpush adds to the head, lrange(0, count-1) returns
    // the most recent "count" entries in newest-first order --
    // exactly what the SDK expects for audit log retrieval.
    return this.client.lrange(this.listPrefix + key, 0, count - 1);
  }
}
```

::: tip
The key design constraint for custom stores is that `increment()` must be **atomic**. A non-atomic read-then-write implementation could allow concurrent `execute()` calls to exceed spending limits. Redis handles this natively with `INCRBYFLOAT`. For other backends, use database transactions or conditional writes.
:::

### Using a Custom Store

```typescript
// Import all the core Kova components needed to wire up a wallet.
import { AgentWallet, PolicyEngine, LocalSigner, SolanaAdapter } from "kova";
// Import the custom RedisStore we defined above.
import { RedisStore } from "./redis-store";

// Create a RedisStore instance pointing to your Redis server.
// In production, this would typically be a Redis Sentinel or Cluster URL.
const store = new RedisStore("redis://localhost:6379");

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

## See Also

- [SpendingLimitRule](/guide/rules/spending-limit) -- uses the store to track spending counters with TTL-based rolling windows
- [RateLimitRule](/guide/rules/rate-limit) -- uses the store to track transaction frequency counters
- [Signers](/guide/signers) -- the key-management component that pairs with stores to form the wallet infrastructure
- [Chain Adapters](/guide/chain-adapters) -- the blockchain communication layer that completes the wallet architecture
