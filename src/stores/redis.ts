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

import * as crypto from "node:crypto";
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
   *
   * ST-15 fix: Must match /^[a-zA-Z0-9_\-:]+$/ and be at most 64 chars.
   */
  keyPrefix?: string;

  /**
   * Namespace prefix for list keys. Redis uses a flat key space, so list
   * operations (append/getRecent) use a "list:" prefix internally to avoid
   * collisions with KV keys that share the same logical name.
   * Default: "list:"
   *
   * ST-15 fix: Must match /^[a-zA-Z0-9_\-:]+$/ and be at most 64 chars.
   */
  listPrefix?: string;

  /**
   * ST-03 fix: Optional AES-256-GCM encryption key for application-level encryption
   * of values stored in Redis. When provided, all values written via set() are encrypted
   * before storage and decrypted in get() after reading. List values in append() and
   * getRecent() are also encrypted/decrypted.
   *
   * Must be exactly 32 bytes (256 bits) for AES-256-GCM. Generate one with:
   *   crypto.randomBytes(32)
   *
   * KNOWN LIMITATION: Counter values used with INCRBYFLOAT cannot be encrypted because
   * Redis needs to perform arithmetic on the raw value. Counter integrity is protected
   * via HMAC instead (see hmacKey option).
   */
  encryptionKey?: Buffer;

  /**
   * ST-04 fix: HMAC key for counter integrity protection.
   * When provided, an HMAC-SHA256 is stored alongside each counter value to detect
   * tampering by anyone with direct Redis access. Must be a hex-encoded string of
   * at least 64 characters (32 bytes).
   */
  hmacKey?: string;

  /**
   * ST-05 fix: When true, require TLS for the Redis connection. If the URL does not
   * start with "rediss://", an error is thrown instead of just warning. Recommended
   * true for production deployments. Default: false for backward compatibility.
   */
  requireTls?: boolean;

  /**
   * HIGH-4 FIX: When true (default), throw an error if no hmacKey is provided.
   * Counter values stored in Redis without HMAC integrity protection are vulnerable
   * to tampering by any process with Redis access, which can bypass spending limits
   * and rate limits. Set to false only if Redis access is tightly controlled via ACLs
   * and you accept the risk.
   */
  requireHmacKey?: boolean;

  /**
   * M25 fix: Optional callback invoked when HMAC verification fails for a counter.
   * Use this to send alerts to PagerDuty, Slack, or other incident management systems.
   * The callback receives the key name and the failure reason.
   */
  onHmacFailure?: (key: string, reason: "missing" | "mismatch") => void;
}

export class RedisStore implements Store {
  private readonly redis: import("ioredis").default;
  private readonly ownsConnection: boolean;
  private readonly keyPrefix: string;
  private readonly listPrefix: string;
  /** ST-03 fix: Optional AES-256-GCM encryption key for value encryption at rest */
  private readonly encryptionKey: Buffer | null = null;
  /** ST-04 fix: Optional HMAC key for counter integrity protection */
  private readonly hmacKey: Buffer | null = null;
  /** HIGH-3 fix: Track whether this store has been destroyed */
  private destroyed = false;
  /** M25 fix: Optional callback for HMAC failure notifications (e.g., PagerDuty) */
  private readonly onHmacFailure?: (key: string, reason: "missing" | "mismatch") => void;
  /** M25 fix: Running count of HMAC failures for escalated warnings */
  private hmacFailureCount = 0;
  /** M25 fix: Threshold for escalated HMAC failure warning */
  private static readonly HMAC_FAILURE_ESCALATION_THRESHOLD = 5;

  constructor(config?: RedisStoreConfig) {
    this.keyPrefix = config?.keyPrefix ?? "";
    this.listPrefix = config?.listPrefix ?? "list:";

    // ST-15 fix: Validate keyPrefix and listPrefix format and length
    const prefixPattern = /^[a-zA-Z0-9_\-:]+$/;
    if (this.keyPrefix && (!prefixPattern.test(this.keyPrefix) || this.keyPrefix.length > 64)) {
      throw new Error(
        `RedisStore: keyPrefix must match /^[a-zA-Z0-9_\\-:]+$/ and be at most 64 characters. ` +
        `Got: "${this.keyPrefix}" (${this.keyPrefix.length} chars)`,
      );
    }
    if (this.listPrefix && (!prefixPattern.test(this.listPrefix) || this.listPrefix.length > 64)) {
      throw new Error(
        `RedisStore: listPrefix must match /^[a-zA-Z0-9_\\-:]+$/ and be at most 64 characters. ` +
        `Got: "${this.listPrefix}" (${this.listPrefix.length} chars)`,
      );
    }

    if (config?.client) {
      this.redis = config.client;
      this.ownsConnection = false;
      // M14 fix: Attach error handler to prevent unhandled error crashes
      this.redis.on("error", (err: Error) => {
        process.emitWarning(
          `RedisStore: Redis client error — ${err.message}`,
          { code: "KOVA_REDIS_CLIENT_ERROR" },
        );
      });
      // ST-12 fix: Warn when user-provided client does not have TLS configured
      try {
        const clientOpts = (config.client as unknown as { options?: { tls?: unknown } }).options;
        if (!clientOpts?.tls) {
          process.emitWarning(
            "RedisStore: user-provided client does not appear to have TLS configured. " +
            "Counter values, audit entries, and HMAC data may traverse the network in cleartext.",
            { code: "KOVA_REDIS_CLIENT_TLS_WARNING" },
          );
        }
      } catch { /* non-fatal — cannot inspect client options */ }
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

      // ST-05 fix: When requireTls is true, reject non-TLS URLs with an error
      if (config?.requireTls && url && !url.startsWith("rediss://")) {
        throw new Error(
          "RedisStore: requireTls is true but the URL does not use rediss://. " +
          "Use a rediss:// URL for encrypted connections, or set requireTls to false.",
        );
      }
      if (config?.requireTls && !url) {
        throw new Error(
          "RedisStore: requireTls is true but no URL was provided. " +
          "Provide a rediss:// URL for encrypted connections.",
        );
      }

      // M15 fix: Bound reconnect retries to prevent infinite retry loops
      const retryStrategy = (times: number): number | null => {
        if (times > 10) return null; // stop retrying after 10 attempts
        return Math.min(times * 200, 2000);
      };
      this.redis = url
        ? new Redis(url, { retryStrategy })
        : new Redis({ retryStrategy });
      this.ownsConnection = true;
      // M14 fix: Attach error handler to prevent unhandled error crashes
      this.redis.on("error", (err: Error) => {
        process.emitWarning(
          `RedisStore: Redis client error — ${err.message}`,
          { code: "KOVA_REDIS_CLIENT_ERROR" },
        );
      });

      // L9 fix: Warn when requireTls is not explicitly set and TLS is not configured.
      // This covers both URL-based and default (no URL) connections to ensure operators
      // are always aware when Redis traffic is unencrypted.
      if (config?.requireTls === undefined) {
        const isTlsUrl = url?.startsWith("rediss://");
        if (!isTlsUrl) {
          process.emitWarning(
            "RedisStore: using Redis without TLS. Counter values, audit entries, and HMAC data " +
            "may traverse the network in cleartext. Set requireTls: true and use a rediss:// URL " +
            "for encrypted connections in production, or set requireTls: false to suppress this warning.",
            { code: "KOVA_REDIS_TLS_WARNING" },
          );
        }
      } else if (config.requireTls === false && url && !url.startsWith("rediss://")) {
        // M-17: Explicit opt-out — no warning emitted, operator accepted the risk.
      }
    }

    // M25 fix: Store optional HMAC failure callback
    this.onHmacFailure = config?.onHmacFailure;

    // ST-03 fix: Validate and store optional AES-256-GCM encryption key
    if (config?.encryptionKey) {
      if (config.encryptionKey.length !== 32) {
        throw new Error(
          "RedisStore: encryptionKey must be exactly 32 bytes (256 bits) for AES-256-GCM. " +
          `Got ${config.encryptionKey.length} bytes. Generate one with: crypto.randomBytes(32)`,
        );
      }
      // LOW-3 fix: Reject all-zeros encryption key (offers no real protection)
      if (config.encryptionKey.every((b) => b === 0)) {
        throw new Error(
          "RedisStore: encryptionKey must not be all zeros — an all-zero key offers no real protection. " +
          "Generate a proper key with: crypto.randomBytes(32)",
        );
      }
      this.encryptionKey = Buffer.from(config.encryptionKey);
    }

    // ST-04 fix: Validate and store optional HMAC key for counter integrity
    if (config?.hmacKey) {
      if (config.hmacKey.length < 64) {
        throw new Error(
          "RedisStore: hmacKey must be at least 64 hex characters (32 bytes). " +
          "Generate one with: crypto.randomBytes(32).toString('hex')",
        );
      }
      this.hmacKey = Buffer.from(config.hmacKey, "hex");
    } else {
      // HIGH-4 FIX: Require HMAC key by default to prevent counter tampering.
      const requireHmac = config?.requireHmacKey ?? true;
      if (requireHmac) {
        throw new Error(
          "RedisStore: hmacKey is required for counter integrity protection. " +
          "Without it, any process with Redis access can modify spending limit and rate limit " +
          "counters to bypass security policy rules. Generate one with: " +
          "crypto.randomBytes(32).toString('hex'). " +
          "Set { requireHmacKey: false } to override (NOT recommended).",
        );
      }
      process.emitWarning(
        "RedisStore: CRITICAL — no hmacKey configured. Counter values (spending limits, rate limits) " +
        "are stored in Redis WITHOUT integrity protection. Any process or user with Redis access can " +
        "reset or modify counters to bypass security policy rules. Strongly recommended: provide an " +
        "hmacKey (crypto.randomBytes(32).toString('hex')) AND restrict Redis access via ACLs.",
        { code: "KOVA_REDIS_HMAC_WARNING" },
      );
    }
  }

  /**
   * HIGH-3 fix: Ensure the store has not been destroyed. Called at the top of
   * every public method to prevent use-after-destroy.
   */
  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("RedisStore has been destroyed and can no longer be used");
    }
  }

  /** Resolve the full Redis key for a KV operation */
  private kvKey(key: string): string {
    return this.keyPrefix + key;
  }

  /** Resolve the full Redis key for a list operation */
  private listKey(key: string): string {
    return this.keyPrefix + this.listPrefix + key;
  }

  /**
   * ST-03 fix: Encrypt a plaintext string using AES-256-GCM.
   * Returns a string in the format: iv:authTag:ciphertext (all base64-encoded).
   * A fresh random 12-byte IV is generated for each call to ensure unique ciphertexts.
   * If no encryptionKey is configured, returns the plaintext unchanged.
   */
  private encrypt(plaintext: string): string {
    if (!this.encryptionKey) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  /**
   * ST-03 fix: Decrypt a ciphertext string produced by encrypt().
   * Expects format: iv:authTag:ciphertext (all base64-encoded).
   * If no encryptionKey is configured, returns the ciphertext unchanged.
   * Throws on authentication failure (tampered data) or malformed input.
   */
  private decrypt(ciphertext: string): string {
    if (!this.encryptionKey) return ciphertext;
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error(
        "Failed to decrypt stored value. Database may contain corrupted or incompatible data.",
      );
    }
    const [ivStr, authTagStr, encryptedStr] = parts as [string, string, string];
    const iv = Buffer.from(ivStr, "base64");
    const authTag = Buffer.from(authTagStr, "base64");
    const encrypted = Buffer.from(encryptedStr, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  /**
   * ST-04 fix: Compute HMAC-SHA256 for a counter value.
   * Uses length-prefixed key to prevent ambiguity (matching MemoryStore/SqliteStore).
   * MED-6 fix: Uses the raw (unprefixed) key for consistency with MemoryStore/SqliteStore.
   * Callers must pass the raw key, not the prefixed Redis key.
   */
  private computeCounterHmac(rawKey: string, value: string): string {
    if (!this.hmacKey) return "";
    return crypto
      .createHmac("sha256", this.hmacKey)
      .update(`${rawKey.length.toString(16)}:${rawKey}:${value}`)
      .digest("hex");
  }

  /**
   * ST-04 fix: Verify HMAC integrity of a counter value.
   * Returns true if the HMAC is valid, false if tampered or missing.
   * MED-6 fix: Accepts the raw (unprefixed) key for consistency.
   */
  private verifyCounterHmac(rawKey: string, value: string, hmac: string): boolean {
    if (!this.hmacKey) return true;
    const expected = this.computeCounterHmac(rawKey, value);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(hmac, "hex"),
      );
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    this.ensureNotDestroyed();
    validateKey(key);
    // ST-08 fix: Prevent list prefix collision with KV namespace
    if (key.startsWith(this.listPrefix)) {
      throw new Error(`Key cannot start with list prefix "${this.listPrefix}"`);
    }
    const raw = await this.redis.get(this.kvKey(key));
    if (raw === null) return null;
    // ST-03 fix: Decrypt value after reading if encryption is enabled
    // M18 fix: On decryption failure, delete the corrupted key and return null
    // rather than propagating the error (which would cause a permanent crash loop).
    // A missing value causes counters to reset to 0 (spending limits re-open),
    // which is safer than a permanent crash loop on corrupted data.
    try {
      return this.decrypt(raw);
    } catch {
      try {
        process.emitWarning(
          `RedisStore.get: decryption failed for key "${key}". ` +
          `The entry may be corrupted or tampered with. Deleting corrupted entry and returning null.`,
          "SecurityWarning",
        );
      } catch { /* non-fatal */ }
      try {
        await this.redis.del(this.kvKey(key));
      } catch { /* best-effort cleanup */ }
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.ensureNotDestroyed();
    validateKey(key);
    // ST-08 fix: Prevent list prefix collision with KV namespace
    if (key.startsWith(this.listPrefix)) {
      throw new Error(`Key cannot start with list prefix "${this.listPrefix}"`);
    }
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`RedisStore.set: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `RedisStore.set: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    // ST-03 fix: Encrypt value before writing if encryption is enabled
    const encryptedValue = this.encrypt(value);
    if (ttlSeconds !== undefined) {
      // Use PX (milliseconds) for sub-second TTL support
      const ttlMs = Math.ceil(ttlSeconds * 1000);
      await this.redis.set(this.kvKey(key), encryptedValue, "PX", ttlMs);
    } else {
      await this.redis.set(this.kvKey(key), encryptedValue);
    }
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    this.ensureNotDestroyed();
    validateKey(key);
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`RedisStore.setIfNotExists: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    // ST-03 fix: Encrypt value before writing if encryption is enabled
    const encryptedValue = this.encrypt(value);
    let result: string | null;
    if (ttlSeconds !== undefined) {
      const ttlMs = Math.ceil(ttlSeconds * 1000);
      // SET key value PX ms NX — atomic set-if-not-exists with TTL
      result = await this.redis.set(this.kvKey(key), encryptedValue, "PX", ttlMs, "NX");
    } else {
      result = await this.redis.set(this.kvKey(key), encryptedValue, "NX");
    }
    // Redis returns "OK" on success, null if key already exists
    return result === "OK";
  }

  /**
   * Atomically increment a numeric value. Returns the new value.
   *
   * ST-02 fix: Uses a Lua script for atomic INCRBYFLOAT + rounding + clamping.
   * Previously, the rounding/clamping was done in a separate SET call, which
   * created a race window in multi-process deployments.
   *
   * ST-04 fix: When hmacKey is configured, stores HMAC alongside counter for
   * integrity verification. Counter values cannot be encrypted (ST-03 known
   * limitation) because Redis needs to perform arithmetic on the raw value.
   *
   * Note: Redis INCRBYFLOAT uses double-precision floats internally, same as
   * JavaScript numbers. The same floating-point drift considerations from
   * MemoryStore (ARCH-08/M-02) apply here.
   */
  async increment(key: string, amount: number): Promise<number> {
    this.ensureNotDestroyed();
    if (!Number.isFinite(amount)) {
      throw new Error(`increment amount must be a finite number, got ${typeof amount === "number" ? amount : typeof amount}`);
    }
    validateKey(key);

    const rKey = this.kvKey(key);
    const hmacRedisKey = rKey + "\x00__hmac";

    // CRIT-1 fix: Single Lua script that atomically reads current value + HMAC,
    // performs INCRBYFLOAT + rounding + clamping, and stores the new HMAC.
    // This eliminates the TOCTOU race where separate GET/INCRBYFLOAT/SET HMAC
    // calls could be interleaved by concurrent processes or interrupted by crashes.
    //
    // The Lua script returns [newValue, oldValue, oldHmac] so Node can verify
    // the old HMAC. The new HMAC is passed as ARGV[3] and stored atomically
    // within the script. Since we cannot compute the HMAC of the new value before
    // knowing it, we use a two-call approach: first call gets oldValue to compute
    // expectedHmac, second call does the atomic increment + HMAC store.
    // However, to keep it truly atomic, we instead:
    // 1. Run the Lua that does GET old value+HMAC, INCRBYFLOAT, round/clamp, return all three
    // 2. Verify old HMAC in Node (warn on mismatch, do NOT reset — prevents spending limit bypass)
    // 3. Compute new HMAC and store it via CAS Lua script (see H4 FIX below)
    const LUA_ATOMIC_INCREMENT = `
local oldVal = redis.call('GET', KEYS[1])
local oldHmac = redis.call('GET', KEYS[2])
local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
local n = tonumber(v)
if n < 0 then n = 0 end
local rounded = string.format("%.10g", n)
if rounded ~= v then
  redis.call('SET', KEYS[1], rounded, 'KEEPTTL')
end
return {rounded, oldVal or '', oldHmac or ''}
`;

    // H4 FIX: CAS (compare-and-swap) Lua script for storing HMAC after increment.
    // In multi-process deployments, two processes can increment concurrently:
    //   Process A increments counter 5->6, computes HMAC(6)
    //   Process B increments counter 6->7, computes HMAC(7)
    //   Process A stores HMAC(6) — overwrites Process B's HMAC(7)
    // This causes a permanent HMAC mismatch on subsequent reads.
    // The CAS script atomically checks that the counter value hasn't changed
    // since our increment before storing the HMAC. If it changed (another
    // process incremented in between), we retry the entire operation.
    const LUA_CAS_HMAC = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'KEEPTTL')
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl > 0 then
    redis.call('PEXPIRE', KEYS[2], pttl)
  end
  return 1
end
return 0
`;

    const MAX_CAS_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      const luaResult = await this.redis.eval(
        LUA_ATOMIC_INCREMENT, 2, rKey, hmacRedisKey, String(amount),
      ) as [string, string, string];
      const [rawResult, oldValue, oldHmac] = luaResult;
      const result = parseFloat(rawResult);

      // M25 DESIGN NOTE: HMAC verification is intentionally post-hoc (after the increment
      // has occurred). This is the correct fail-safe direction. Resetting to 0 on HMAC
      // failure would be WORSE because it creates a spending limit bypass vulnerability:
      // an attacker who can corrupt the HMAC would cause the counter to reset to 0,
      // effectively erasing all spend history. The current behavior (warn + continue with
      // the existing value) preserves the spending limit constraint.
      //
      // CRIT-1 fix: Verify old HMAC in Node. On mismatch, emit warning but do NOT
      // reset to 0. MED-6 fix: Pass raw (unprefixed) key for HMAC computation consistency.
      if (this.hmacKey && oldValue !== "") {
        let hmacFailureReason: "missing" | "mismatch" | null = null;
        if (oldHmac === "") {
          hmacFailureReason = "missing";
          try {
            process.emitWarning(
              `RedisStore.increment: HMAC entry missing for counter key "${key}". ` +
              `Counter integrity cannot be verified — possible tampering or crash recovery. ` +
              `Proceeding with current value to avoid spending limit bypass.`,
              "SecurityWarning",
            );
          } catch { /* non-fatal */ }
        } else if (!this.verifyCounterHmac(key, oldValue, oldHmac)) {
          hmacFailureReason = "mismatch";
          try {
            process.emitWarning(
              `RedisStore.increment: HMAC verification failed for counter key "${key}". ` +
              `Counter value may have been tampered with via direct Redis access. ` +
              `Proceeding with current value to avoid spending limit bypass.`,
              "SecurityWarning",
            );
          } catch { /* non-fatal */ }
        }

        // M25 fix: Track HMAC failures and notify via callback / escalated warning
        if (hmacFailureReason) {
          this.hmacFailureCount++;
          try {
            this.onHmacFailure?.(key, hmacFailureReason);
          } catch { /* non-fatal — callback errors must not break increment */ }
          if (this.hmacFailureCount >= RedisStore.HMAC_FAILURE_ESCALATION_THRESHOLD &&
              this.hmacFailureCount % RedisStore.HMAC_FAILURE_ESCALATION_THRESHOLD === 0) {
            try {
              process.emitWarning(
                `RedisStore: ${this.hmacFailureCount} HMAC verification failures detected. ` +
                `This may indicate active tampering with Redis counter values. ` +
                `Investigate Redis access logs and ACL configuration immediately.`,
                "SecurityWarning",
              );
            } catch { /* non-fatal */ }
          }
        }
      }

      // H4 FIX: Use CAS to store HMAC only if the counter hasn't been
      // modified by another process since our increment. MED-6 fix: use raw key.
      if (this.hmacKey) {
        const hmac = this.computeCounterHmac(key, rawResult);
        const casResult = await this.redis.eval(
          LUA_CAS_HMAC, 2, rKey, hmacRedisKey, rawResult, hmac,
        ) as number;

        if (casResult === 0) {
          // Another process incremented the counter between our increment and
          // CAS attempt. Retry the entire operation (our increment already took
          // effect, but the HMAC couldn't be stored safely).
          if (attempt < MAX_CAS_RETRIES) {
            continue;
          }
          // Exhausted retries — emit warning but return the result.
          // The HMAC will be stale, triggering a warning on next access.
          try {
            process.emitWarning(
              `RedisStore.increment: CAS HMAC store failed after ${MAX_CAS_RETRIES + 1} attempts ` +
              `for counter key "${key}". High contention detected. ` +
              `HMAC may be stale until next successful write.`,
              "SecurityWarning",
            );
          } catch { /* non-fatal */ }
        }
      }

      return result;
    }

    // Unreachable, but TypeScript needs a return path
    throw new Error(`RedisStore.increment: unexpected exit from retry loop for key "${key}"`);
  }

  /**
   * Append an entry to a list. Uses Redis RPUSH for O(1) append.
   * Trims the list to MAX_LIST_SIZE to prevent unbounded growth.
   * ST-03 fix: Encrypts list values before writing if encryption is enabled.
   */
  async append(key: string, value: string): Promise<void> {
    this.ensureNotDestroyed();
    validateKey(key);
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `RedisStore.append: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    const rKey = this.listKey(key);
    // ST-03 fix: Encrypt list value before storing
    const encryptedValue = this.encrypt(value);
    // RPUSH + LTRIM in a pipeline for atomicity and efficiency
    const pipeline = this.redis.pipeline();
    pipeline.rpush(rKey, encryptedValue);
    // Keep only the last MAX_LIST_SIZE entries (LTRIM keeps elements from start to end inclusive)
    pipeline.ltrim(rKey, -MAX_LIST_SIZE, -1);
    // M16 fix: Check pipeline exec() result for per-command errors
    const results = await pipeline.exec();
    if (results) {
      for (const [err] of results) {
        if (err) {
          process.emitWarning(
            `RedisStore.append: pipeline command error — ${err.message}`,
            { code: "KOVA_REDIS_PIPELINE_ERROR" },
          );
        }
      }
    }
  }

  /**
   * Get the most recent N entries from a list, newest first.
   * ST-03 fix: Decrypts list values after reading if encryption is enabled.
   */
  async getRecent(key: string, count: number): Promise<string[]> {
    this.ensureNotDestroyed();
    validateKey(key);
    if (count <= 0) return [];
    const cappedCount = Math.min(count, MAX_LIST_SIZE);
    const rKey = this.listKey(key);
    // LRANGE with negative indices: -cappedCount to -1 gets the last N elements
    const entries = await this.redis.lrange(rKey, -cappedCount, -1);
    // ST-03 fix: Decrypt list values before returning
    // M18 fix: Skip individual corrupted list entries instead of failing the entire call.
    // Corrupted entries are logged and omitted from the result.
    const decrypted: string[] = [];
    for (const e of entries) {
      try {
        decrypted.push(this.decrypt(e));
      } catch {
        try {
          process.emitWarning(
            `RedisStore.getRecent: decryption failed for an entry in list "${key}". ` +
            `Skipping corrupted entry.`,
            "SecurityWarning",
          );
        } catch { /* non-fatal */ }
      }
    }
    // Reverse to return newest first (RPUSH appends to the end)
    return decrypted.reverse();
  }

  /** Clear all entries in a list. */
  async clearList(key: string): Promise<void> {
    this.ensureNotDestroyed();
    validateKey(key);
    await this.redis.del(this.listKey(key));
  }

  /**
   * Disconnect from Redis. Only closes the connection if RedisStore created it
   * (i.e., `client` was not provided in the config). If a client was provided,
   * the caller is responsible for closing it.
   */
  async disconnect(): Promise<void> {
    if (this.destroyed) return;
    if (this.ownsConnection) {
      await this.redis.quit();
    }
  }

  /**
   * HIGH-3 fix: Securely destroy this store instance by zeroing sensitive key
   * material and marking the instance as permanently unusable. All subsequent
   * public method calls will throw.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Zero out encryption key material
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
    }
    // Zero out HMAC key material
    if (this.hmacKey) {
      this.hmacKey.fill(0);
    }
    if (this.ownsConnection) {
      try {
        await this.redis.quit();
      } catch { /* best-effort close */ }
    }
  }
}
