# Building a Custom Store Adapter

---

::: tip USING REDIS?
If you just need a Redis-backed store, you don't need to build a custom adapter -- kova ships with a built-in `RedisStore`. See the [Stores guide](/guide/stores#redisstore) for usage. This tutorial is for integrating with **other** backends (Postgres, DynamoDB, Turso, Upstash, etc.) or for understanding how the Store interface works under the hood.
:::

## What You'll Build

In this tutorial, you'll build a custom `Store` adapter backed by Redis as a learning exercise. By the end, you will understand exactly how the SDK's persistence layer works and be able to wire any database (Postgres, DynamoDB, Turso, Upstash, etc.) into kova.

The `Store` interface has 7 methods (one optional). If you can implement those methods, your adapter works with every SDK feature -- spending limits, rate limits, audit logs, circuit breakers, and idempotency caches.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |

You should also have a working kova project. If you followed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial, you are ready to go.

A running Redis instance is helpful but not required -- we will write the adapter first and test it with a mock.

---

## Step 1: Understand the Store Interface

Every store adapter implements this interface:

```typescript
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  increment(key: string, amount: number): Promise<number>;
  append(key: string, value: string): Promise<void>;
  getRecent(key: string, count: number): Promise<string[]>;
  clearList?(key: string): Promise<void>; // optional
}
```

Here is what each method does and which SDK feature uses it:

| Method | Purpose | Used By |
|--------|---------|---------|
| `get(key)` | Read a value by key. Return `null` if not found or expired. | Spending limits, rate limits, circuit breaker, idempotency cache |
| `set(key, value, ttl?)` | Write a value. Optionally auto-expire after `ttlSeconds`. | Rate limit windows, idempotency cache, circuit breaker state |
| `setIfNotExists(key, value, ttl?)` | Write a value only if the key does not already exist. Return `true` if the key was set. | Distributed mutex, idempotency cache |
| `increment(key, amount)` | Atomically add `amount` to a numeric key. Return the new total. Create the key if it does not exist. | Spending limit counters, rate limit counters |
| `append(key, value)` | Add an entry to the end of a list. | Audit log entries |
| `getRecent(key, count)` | Return the most recent `count` entries from a list, newest first. | Audit log retrieval, transaction history |
| `clearList?(key)` | *(Optional)* Remove all entries from a list. | Test cleanup, log rotation |

All methods return `Promise` so they work with both local and remote backends.

::: tip KEY DESIGN CONSTRAINT
`increment()` must be **atomic**. If two concurrent `execute()` calls try to update the same spending counter at the same instant, each one must see the other's update. A non-atomic read-then-write would let the agent exceed its spending limit. Most databases provide an atomic increment operation (Redis `INCRBYFLOAT`, SQL `UPDATE ... SET value = value + ?`, DynamoDB `ADD`).
:::

---

## Step 2: Create the File

Create a new file for your custom store:

```bash
touch redis-store.ts
```

Open it and add the import:

```typescript
// Import the Store interface that our custom class must implement.
import type { Store } from "kova";
// Import the ioredis client library for connecting to a Redis server.
// Install it with: npm install ioredis
import Redis from "ioredis";
```

---

## Step 3: Implement `get()`, `set()`, and `setIfNotExists()`

These are the simplest methods. Redis handles TTL natively with the `EX` flag, and `NX` for set-if-not-exists.

```typescript
export class RedisStore implements Store {
  private readonly client: Redis;

  // A key prefix to separate list data from scalar key-value data in Redis,
  // since both use string keys but have different Redis data structures.
  private readonly listPrefix = "list:";

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }

  async get(key: string): Promise<string | null> {
    // Redis returns null automatically for missing or expired keys.
    // No manual TTL check needed -- Redis handles expiration natively.
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      // "EX" tells Redis to auto-expire this key after ttlSeconds.
      // Used by the SDK for rate limit windows and idempotency cache entries.
      await this.client.set(key, value, "EX", ttlSeconds);
    } else {
      // No TTL -- the key persists until explicitly deleted.
      await this.client.set(key, value);
    }
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      // "NX" tells Redis to only set the key if it does not already exist.
      // Combined with "EX" for automatic expiration.
      // Used by the SDK for distributed mutex and idempotency cache.
      const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
      return result === "OK";
    } else {
      const result = await this.client.setnx(key, value);
      return result === 1;
    }
  }
}
```

::: details Why does `get()` return `string | null`?
The SDK stores all values as strings. Numbers are serialized (e.g., `"42.5"`) and parsed back when needed. This keeps the Store interface simple -- your adapter only deals with strings, regardless of what the SDK is actually storing.
:::

---

## Step 4: Implement `increment()`

This is the most important method to get right. It must be atomic.

```typescript
  async increment(key: string, amount: number): Promise<number> {
    // INCRBYFLOAT is a single atomic Redis command.
    // It increments the value at `key` by `amount` and returns the new total.
    // If the key does not exist, Redis creates it with value "0" first.
    // Because this is one atomic operation, concurrent calls cannot
    // read a stale value -- each increment sees the result of all previous ones.
    const result = await this.client.incrbyfloat(key, amount);
    return parseFloat(result);
  }
```

::: warning ATOMICITY IS NOT OPTIONAL
If your backend does not have a native atomic increment, you must use a transaction or compare-and-swap loop. Here is what goes wrong without atomicity:

1. Transaction A reads counter: `8.0`
2. Transaction B reads counter: `8.0` (same stale value)
3. Transaction A writes: `8.0 + 2.0 = 10.0`
4. Transaction B writes: `8.0 + 2.0 = 10.0`
5. Real total should be `12.0`, but it is `10.0` -- the agent just exceeded its spending limit

Redis `INCRBYFLOAT`, PostgreSQL `UPDATE ... SET value = value + $1 RETURNING value`, and DynamoDB `ADD` are all atomic. A plain read-then-write is not.
:::

---

## Step 5: Implement `append()` and `getRecent()`

These methods manage ordered lists for the audit log. The SDK appends new entries and reads them back newest-first.

```typescript
  async append(key: string, value: string): Promise<void> {
    // LPUSH inserts at the head (left) of the Redis list.
    // This means the newest entry is always at index 0.
    // The listPrefix prevents collisions with scalar keys from get/set.
    await this.client.lpush(this.listPrefix + key, value);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    // LRANGE 0 to count-1 returns the first `count` elements.
    // Since LPUSH inserts at the head, this gives us the newest entries first --
    // exactly the order the SDK expects for audit log retrieval.
    return this.client.lrange(this.listPrefix + key, 0, count - 1);
  }
```

::: tip WHY `LPUSH` INSTEAD OF `RPUSH`?
Using `LPUSH` (insert at head) means the newest entry is always at the start of the list. This makes `getRecent()` a simple `LRANGE(0, count - 1)` without needing to know the total list length. If you used `RPUSH` (insert at tail), you would need `LRANGE(-count, -1)` and then reverse the result.
:::

---

## Step 6: Put It All Together

Here is the complete `RedisStore` in one file:

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

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
      return result === "OK";
    } else {
      const result = await this.client.setnx(key, value);
      return result === 1;
    }
  }

  async increment(key: string, amount: number): Promise<number> {
    const result = await this.client.incrbyfloat(key, amount);
    return parseFloat(result);
  }

  async append(key: string, value: string): Promise<void> {
    await this.client.lpush(this.listPrefix + key, value);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    return this.client.lrange(this.listPrefix + key, 0, count - 1);
  }

  /** Optional: remove all entries from a list. */
  async clearList(key: string): Promise<void> {
    await this.client.del(this.listPrefix + key);
  }

  /** Disconnect from Redis. Call this during application shutdown. */
  async close(): Promise<void> {
    await this.client.quit();
  }
}
```

That's it -- 40 lines of actual logic. The Store interface is deliberately minimal so that adapters are trivial to write.

---

## Step 7: Wire It Into the SDK

Replace `MemoryStore` or `SqliteStore` with your custom adapter:

```typescript
import { AgentWallet, PolicyEngine, LocalSigner, SolanaAdapter } from "kova";
import { RedisStore } from "./redis-store";

// Point at your Redis instance.
const store = new RedisStore("redis://localhost:6379");

// Create the policy engine with your Redis-backed store.
// Spending counters, rate limit windows, and circuit breaker state
// are all persisted in Redis now.
const engine = new PolicyEngine(rules, store);

// Create the wallet. The same store instance is shared between
// the policy engine and the wallet, so all safety state is consistent.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});

// Gracefully close on shutdown.
process.on("SIGTERM", async () => {
  await store.close();
  process.exit(0);
});
```

The wallet does not know or care that it is talking to Redis. It calls the same 7 methods regardless of the backend.

---

## Step 8: Test Your Adapter

You can verify your adapter against the same contract the built-in stores follow. Here is a minimal test suite you can adapt:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { RedisStore } from "./redis-store";

describe("RedisStore", () => {
  let store: RedisStore;

  beforeEach(async () => {
    store = new RedisStore("redis://localhost:6379");
    // Flush test keys (use a dedicated test database in practice)
  });

  describe("get / set", () => {
    it("should return null for missing keys", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });

    it("should store and retrieve a value", async () => {
      await store.set("key1", "hello");
      expect(await store.get("key1")).toBe("hello");
    });

    it("should overwrite existing values", async () => {
      await store.set("key1", "first");
      await store.set("key1", "second");
      expect(await store.get("key1")).toBe("second");
    });

    it("should expire keys after TTL", async () => {
      await store.set("temp", "value", 1); // 1 second TTL
      expect(await store.get("temp")).toBe("value");

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 1100));
      expect(await store.get("temp")).toBeNull();
    });
  });

  describe("increment", () => {
    it("should create key with initial value if not exists", async () => {
      const result = await store.increment("counter", 5);
      expect(result).toBe(5);
    });

    it("should increment existing values", async () => {
      await store.increment("counter", 3);
      const result = await store.increment("counter", 7);
      expect(result).toBe(10);
    });

    it("should handle decimal amounts", async () => {
      await store.increment("counter", 0.1);
      await store.increment("counter", 0.2);
      const result = await store.increment("counter", 0);
      // Allow for minor floating-point drift
      expect(result).toBeCloseTo(0.3, 9);
    });
  });

  describe("append / getRecent", () => {
    it("should return empty array for missing lists", async () => {
      expect(await store.getRecent("log", 10)).toEqual([]);
    });

    it("should return entries newest-first", async () => {
      await store.append("log", "first");
      await store.append("log", "second");
      await store.append("log", "third");

      const recent = await store.getRecent("log", 2);
      expect(recent).toEqual(["third", "second"]);
    });

    it("should return all entries when count exceeds list size", async () => {
      await store.append("log", "only");
      const recent = await store.getRecent("log", 100);
      expect(recent).toEqual(["only"]);
    });

    it("should return empty array for count <= 0", async () => {
      await store.append("log", "entry");
      expect(await store.getRecent("log", 0)).toEqual([]);
      expect(await store.getRecent("log", -1)).toEqual([]);
    });
  });
});
```

If all of these pass, your adapter is compatible with the SDK.

---

## Adapting to Other Databases

The same methods map cleanly to any backend. Here is a quick reference for the core 6 required methods:

| Store Method | Redis | PostgreSQL | DynamoDB |
|---|---|---|---|
| `get(key)` | `GET key` | `SELECT value FROM kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())` | `GetItem({ Key: { pk: key } })` |
| `set(key, val, ttl)` | `SET key val EX ttl` | `INSERT ... ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = NOW() + interval '$3 seconds'` | `PutItem({ Item: { pk: key, value: val, ttl: epoch + ttl } })` with DynamoDB TTL enabled |
| `increment(key, n)` | `INCRBYFLOAT key n` | `UPDATE kv SET value = (value::numeric + $2)::text WHERE key = $1 RETURNING value` | `UpdateItem({ UpdateExpression: "ADD val :n", ... })` |
| `append(key, val)` | `LPUSH list:key val` | `INSERT INTO lists (key, value, created_at) VALUES ($1, $2, NOW())` | `PutItem` with a sort key (e.g., timestamp) |
| `getRecent(key, n)` | `LRANGE list:key 0 n-1` | `SELECT value FROM lists WHERE key = $1 ORDER BY created_at DESC LIMIT $2` | `Query` with `ScanIndexForward: false` and `Limit: n` |

::: tip TTL STRATEGIES
- **Redis**: Native TTL with the `EX` flag. No manual cleanup needed.
- **PostgreSQL**: Store `expires_at` as a timestamp. Check on read, and optionally run a periodic cleanup job.
- **DynamoDB**: Enable [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html) on a `ttl` attribute. DynamoDB deletes expired items automatically (within ~48 hours).
- **SQLite** (built-in `SqliteStore`): Lazy expiration on read, same as `MemoryStore`.
:::

---

## Checklist

Before using your custom store in production, verify:

- [ ] `get()` returns `null` for missing and expired keys
- [ ] `set()` with a TTL causes the key to disappear after expiration
- [ ] `setIfNotExists()` returns `true` only if the key was newly created, `false` if it already existed
- [ ] `increment()` is atomic under concurrent access
- [ ] `increment()` creates the key with the given amount if it does not exist
- [ ] `append()` adds entries that `getRecent()` returns in newest-first order
- [ ] `getRecent()` returns an empty array for `count <= 0` and for missing keys
- [ ] Shutdown is graceful (close connections, flush buffers)

---

## See Also

- [Stores](/guide/stores) -- full reference for `MemoryStore`, `SqliteStore`, and the `Store` interface
- [SpendingLimitRule](/guide/rules/spending-limit) -- uses `increment()` and `get()` for spending counters
- [RateLimitRule](/guide/rules/rate-limit) -- uses `increment()` and `set()` for transaction frequency tracking
- [Audit Logging](/guide/audit-logging) -- uses `append()` and `getRecent()` for tamper-evident logs
