# Stores

Stores provide pluggable persistence for the SDK's internal state. The interface is deliberately minimal (5 methods) to make custom adapters trivial to implement.

## Why the SDK Needs a Store

The store is not for your application data -- it is for Kova's own safety mechanisms. The SDK persists five categories of internal state:

| State | Purpose | What Happens Without Persistence |
|-------|---------|----------------------------------|
| **Spending limit counters** | Tracks how much the agent has spent per day/week/month | Restarting the process resets the counter to zero, so the agent can exceed its configured budget |
| **Rate limit counters** | Tracks how many transactions the agent has executed in the current time window | A restart clears the count, allowing the agent to burst past the rate limit |
| **Circuit breaker state** | Locks the wallet after consecutive policy denials | A restart clears the lockdown, letting the agent immediately retry denied transactions |
| **Audit log** | A hash-chained, tamper-evident record of every transaction attempt and policy decision | You lose the forensic trail needed for debugging and compliance |
| **Idempotency cache** | Prevents duplicate execution if the same intent is submitted twice | A crash followed by a retry could execute the same transfer twice |

In development, `MemoryStore` is fine -- your agent is short-lived and you are not worried about enforcing limits across restarts. In production, you need a persistent store like `SqliteStore` so that these safety guarantees actually hold.

## Store Interface

```typescript
import type { Store } from "kova";
```

```typescript
interface Store {
  /** Get a value by key. Returns null if not found or expired. */
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL (in seconds). */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Atomically increment a numeric value. Returns the new value.
      Creates the key with the given amount if it does not exist. */
  increment(key: string, amount: number): Promise<number>;

  /** Append an entry to a list (for transaction logs). */
  append(key: string, value: string): Promise<void>;

  /** Get the most recent N entries from a list, newest first. */
  getRecent(key: string, count: number): Promise<string[]>;
}
```

All methods return `Promise` -- even in-memory implementations use `async` for interface consistency.

## MemoryStore

In-memory store for development and testing. All data is lost when the process exits.

```typescript
import { MemoryStore } from "kova";

const store = new MemoryStore();
```

### Characteristics

- **TTL expiration**: Checked lazily on read. Expired keys are deleted on access.
- **Atomicity**: `increment()` is synchronous within the async wrapper, so there is no race condition between read and write.
- **Lists**: Stored as in-memory arrays. `getRecent()` returns entries newest-first.
- **Max list size**: Lists are capped at 100,000 entries. When the limit is reached, the oldest entries are evicted (FIFO). This prevents unbounded memory growth from audit logs and transaction history.
- **No persistence**: Data does not survive process restarts.

### clear()

Reset all data. Useful in test suites.

```typescript
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
import { SqliteStore } from "kova";

const store = new SqliteStore({ path: "./wallet-data.db" });
```

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
const store = new SqliteStore({ path: ":memory:" });
```

### close()

Close the database connection. Call this when shutting down.

```typescript
store.close();
```

### clear()

Delete all data from both tables. Useful for testing.

```typescript
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
import type { Store } from "kova";
import Redis from "ioredis";

export class RedisStore implements Store {
  private readonly client: Redis;
  private readonly listPrefix = "list:";

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.set(key, value, "EX", ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async increment(key: string, amount: number): Promise<number> {
    // Redis INCRBYFLOAT handles atomic increment
    const result = await this.client.incrbyfloat(key, amount);
    return parseFloat(result);
  }

  async append(key: string, value: string): Promise<void> {
    await this.client.lpush(this.listPrefix + key, value);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    // lpush + lrange(0, count-1) gives newest first
    return this.client.lrange(this.listPrefix + key, 0, count - 1);
  }
}
```

::: tip
The key design constraint for custom stores is that `increment()` must be **atomic**. A non-atomic read-then-write implementation could allow concurrent `execute()` calls to exceed spending limits. Redis handles this natively with `INCRBYFLOAT`. For other backends, use database transactions or conditional writes.
:::

### Using a Custom Store

```typescript
import { AgentWallet, PolicyEngine, LocalSigner, SolanaAdapter } from "kova";
import { RedisStore } from "./redis-store";

const store = new RedisStore("redis://localhost:6379");

const engine = new PolicyEngine(rules, store);
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});
```

The same `Store` instance is shared between the `PolicyEngine` and `AgentWallet`. This ensures spending counters, rate limits, and audit logs all use the same persistence backend.
