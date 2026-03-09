/**
 * RedisStore — Redis-backed store for multi-process production deployments.
 *
 * Uses Redis data structures directly:
 * - GET/SET/SETNX for key-value pairs with TTL
 * - INCRBYFLOAT for atomic counter increments
 * - RPUSH/LRANGE for append-only lists (transaction logs)
 *
 * All operations are natively atomic in Redis, eliminating the need for
 * application-level mutexes or worker threads. This makes RedisStore
 * suitable for multi-process and multi-instance deployments where
 * SqliteStore's single-process limitation is a blocker.
 *
 * STORE-015 cross-reference: Unlike SqliteStore, RedisStore supports true
 * concurrent access from multiple processes/instances. Spending limits,
 * rate limits, and circuit breaker state are safely shared across all
 * instances connected to the same Redis server.
 *
 * Requires the `ioredis` peer dependency: npm install ioredis
 */

import type { Store } from "./interface.js";

/** Maximum key length to prevent memory exhaustion, matching MemoryStore/SqliteStore */
const MAX_KEY_LENGTH = 512;

/** Maximum value length to prevent unbounded memory consumption */
const MAX_VALUE_LENGTH = 1_000_000;

/** Maximum entries per list to prevent unbounded memory growth */
const MAX_LIST_SIZE = 100_000;

/** Validate store key length and content */
function validateKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Store key exceeds max length of ${MAX_KEY_LENGTH}: ${key.length} chars`);
  }
  if (key.includes("\0")) {
    throw new Error("Store key must not contain null bytes");
  }
}

/**
 * Configuration for RedisStore.
 *
 * Accepts either an ioredis instance (for full control over connection settings,
 * Sentinel, Cluster, etc.) or a Redis URL string for simple setups.
 */
export interface RedisStoreConfig {
  /**
   * An existing ioredis client instance. When provided, RedisStore will use
   * this connection and will NOT close it on disconnect() — the caller owns
   * the lifecycle.
   */
  client?: import("ioredis").default;

  /**
   * Redis connection URL (e.g., "redis://localhost:6379", "rediss://user:pass@host:6380/0").
   * Ignored if `client` is provided. If neither `client` nor `url` is provided,
   * ioredis defaults to localhost:6379.
   */
  url?: string;

  /**
   * Optional key prefix applied to all Redis keys. Useful for namespacing
   * when multiple applications share the same Redis instance.
   * Example: "kova:" → all keys become "kova:spending:daily:SOL", etc.
   *
   * Note: This is separate from PrefixedStore's per-wallet prefix. You can
   * use both — RedisStore prefix for application-level isolation, and
   * PrefixedStore for wallet-level isolation within the application.
   */
  keyPrefix?: string;

  /**
   * Namespace prefix for list keys. Redis uses a flat key space, so list
   * operations (append/getRecent) use a "list:" prefix internally to avoid
   * collisions with KV keys that share the same logical name.
   * Default: "list:"
   */
  listPrefix?: string;
}

export class RedisStore implements Store {
  private readonly redis: import("ioredis").default;
  private readonly ownsConnection: boolean;
  private readonly keyPrefix: string;
  private readonly listPrefix: string;

  constructor(config?: RedisStoreConfig) {
    this.keyPrefix = config?.keyPrefix ?? "";
    this.listPrefix = config?.listPrefix ?? "list:";

    if (config?.client) {
      this.redis = config.client;
      this.ownsConnection = false;
    } else {
      // Lazy-require ioredis so the SDK doesn't fail to import when ioredis
      // is not installed (it's an optional peer dependency).
      let Redis: typeof import("ioredis").default;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("ioredis");
        Redis = mod.default ?? mod;
      } catch {
        throw new Error(
          "RedisStore requires the 'ioredis' package. Install it with: npm install ioredis",
        );
      }
      const url = config?.url;
      this.redis = url ? new Redis(url) : new Redis();
      this.ownsConnection = true;

      // M-17: Warn when the connection does not use TLS. Counter values, audit entries,
      // and HMAC data traverse the network in cleartext without TLS.
      if (url && !url.startsWith("rediss://")) {
        process.emitWarning(
          "RedisStore connection does not use TLS. Counter values, audit entries, and HMAC data " +
          "traverse the network in cleartext. Use rediss:// for encrypted connections in production.",
          { code: "KOVA_REDIS_TLS_WARNING" },
        );
      }
    }

    // M-16: RedisStore does not implement HMAC counter integrity. Counter values can be
    // tampered with by anyone with direct Redis access. Ensure Redis ACLs restrict key
    // access in production.
    process.emitWarning(
      "RedisStore does not implement HMAC counter integrity. Counter values can be tampered with " +
      "by anyone with direct Redis access. Ensure Redis ACLs restrict key access in production.",
      { code: "KOVA_REDIS_HMAC_WARNING" },
    );
  }

  /** Resolve the full Redis key for a KV operation */
  private kvKey(key: string): string {
    return this.keyPrefix + key;
  }

  /** Resolve the full Redis key for a list operation */
  private listKey(key: string): string {
    return this.keyPrefix + this.listPrefix + key;
  }

  async get(key: string): Promise<string | null> {
    validateKey(key);
    return this.redis.get(this.kvKey(key));
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    validateKey(key);
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`RedisStore.set: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `RedisStore.set: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    if (ttlSeconds !== undefined) {
      // Use PX (milliseconds) for sub-second TTL support
      const ttlMs = Math.ceil(ttlSeconds * 1000);
      await this.redis.set(this.kvKey(key), value, "PX", ttlMs);
    } else {
      await this.redis.set(this.kvKey(key), value);
    }
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    validateKey(key);
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`RedisStore.setIfNotExists: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    let result: string | null;
    if (ttlSeconds !== undefined) {
      const ttlMs = Math.ceil(ttlSeconds * 1000);
      // SET key value PX ms NX — atomic set-if-not-exists with TTL
      result = await this.redis.set(this.kvKey(key), value, "PX", ttlMs, "NX");
    } else {
      result = await this.redis.set(this.kvKey(key), value, "NX");
    }
    // Redis returns "OK" on success, null if key already exists
    return result === "OK";
  }

  /**
   * Atomically increment a numeric value. Returns the new value.
   *
   * Uses Redis INCRBYFLOAT which is natively atomic — no application-level
   * locking needed. Clamps to zero floor to match MemoryStore behavior.
   *
   * Note: Redis INCRBYFLOAT uses double-precision floats internally, same as
   * JavaScript numbers. The same floating-point drift considerations from
   * MemoryStore (ARCH-08/M-02) apply here.
   */
  async increment(key: string, amount: number): Promise<number> {
    if (!Number.isFinite(amount)) {
      throw new Error(`increment amount must be a finite number, got ${typeof amount === "number" ? amount : typeof amount}`);
    }
    validateKey(key);

    const rKey = this.kvKey(key);

    // INCRBYFLOAT creates the key at 0 if it doesn't exist, then increments.
    // This is atomic — safe for concurrent multi-process access.
    const rawResult = await this.redis.incrbyfloat(rKey, amount);
    const result = parseFloat(rawResult);

    // M-02 fix: Round to 12 decimal places to limit floating-point drift
    // AUDIT-L-14: Non-atomic rounding/clamping. Use Lua script for atomic operations in multi-process.
    const rounded = parseFloat(result.toFixed(12));

    // L-04 fix: Clamp to zero floor to prevent negative counters
    if (rounded < 0) {
      await this.redis.set(rKey, "0", "KEEPTTL");
      return 0;
    }

    // If rounding changed the value, update Redis to keep it consistent
    if (rounded !== result) {
      await this.redis.set(rKey, String(rounded), "KEEPTTL");
    }

    return rounded;
  }

  /**
   * Append an entry to a list. Uses Redis RPUSH for O(1) append.
   * Trims the list to MAX_LIST_SIZE to prevent unbounded growth.
   */
  async append(key: string, value: string): Promise<void> {
    validateKey(key);
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `RedisStore.append: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    const rKey = this.listKey(key);
    // RPUSH + LTRIM in a pipeline for atomicity and efficiency
    const pipeline = this.redis.pipeline();
    pipeline.rpush(rKey, value);
    // Keep only the last MAX_LIST_SIZE entries (LTRIM keeps elements from start to end inclusive)
    pipeline.ltrim(rKey, -MAX_LIST_SIZE, -1);
    await pipeline.exec();
  }

  /** Get the most recent N entries from a list, newest first. */
  async getRecent(key: string, count: number): Promise<string[]> {
    validateKey(key);
    if (count <= 0) return [];
    const cappedCount = Math.min(count, MAX_LIST_SIZE);
    const rKey = this.listKey(key);
    // LRANGE with negative indices: -cappedCount to -1 gets the last N elements
    const entries = await this.redis.lrange(rKey, -cappedCount, -1);
    // Reverse to return newest first (RPUSH appends to the end)
    return entries.reverse();
  }

  /** Clear all entries in a list. */
  async clearList(key: string): Promise<void> {
    validateKey(key);
    await this.redis.del(this.listKey(key));
  }

  /**
   * Disconnect from Redis. Only closes the connection if RedisStore created it
   * (i.e., `client` was not provided in the config). If a client was provided,
   * the caller is responsible for closing it.
   */
  async disconnect(): Promise<void> {
    if (this.ownsConnection) {
      await this.redis.quit();
    }
  }
}
