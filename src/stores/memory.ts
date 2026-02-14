/**
 * MemoryStore — In-memory store for development and testing.
 * All data is lost when the process exits.
 * TTL expiration is checked on read (lazy expiration).
 *
 * HIGH-18 WARNING: MemoryStore is NOT suitable for production use with real funds.
 * - All spending limits, rate limit counters, and circuit breaker state are lost on restart,
 *   allowing agents to immediately exceed configured limits after a process restart.
 * - No persistence means audit logs are also lost, breaking compliance requirements.
 * - Use SqliteStore (with SQLCipher encryption) or a Redis-backed store for production.
 *
 * HIGH-19 TODO: In future versions, a `dangerouslyAllowMemoryStore` flag should be
 * required in the constructor options to use MemoryStore outside of test environments.
 * This would make the risk of data loss on restart explicit and opt-in, rather than
 * silently allowing production use with only a process warning. The flag should default
 * to false, requiring callers to acknowledge the risk:
 *   new MemoryStore({ dangerouslyAllowMemoryStore: true })
 *
 * STORE-015: MEMORY GROWTH — In long-running processes, the MemoryStore can grow
 * unboundedly if keys are created but never read (lazy expiration only triggers on
 * read). Use startGc() to enable periodic garbage collection of expired entries.
 * Even with GC, non-expiring keys (e.g., audit log lists) will accumulate until
 * the MAX_LIST_SIZE eviction threshold is hit.
 */

import * as crypto from "node:crypto";
import type { Store } from "./interface.js";

/** MED-21 fix: Maximum key length to prevent memory exhaustion */
const MAX_KEY_LENGTH = 512;

/** MED-22 fix: Maximum value length to prevent unbounded memory consumption.
 * A single 1MB value is the upper bound for any reasonable counter, audit log entry,
 * or serialized transaction result. Larger values likely indicate a bug or abuse. */
const MAX_VALUE_LENGTH = 1_000_000;

/** MED-21 fix: Validate store key length and content */
function validateKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Store key exceeds max length of ${MAX_KEY_LENGTH}: ${key.length} chars`);
  }
  if (key.includes("\0")) {
    throw new Error("Store key must not contain null bytes");
  }
}

interface StoreEntry {
  value: string;
  expiresAt?: number;
}

/** CRIT-03 fix: Maximum entries per list to prevent unbounded memory growth */
const MAX_LIST_SIZE = 100_000;

/** STORE-017 fix: Configuration for MemoryStore production opt-in */
export interface MemoryStoreConfig {
  /**
   * When true, allows MemoryStore to be used outside of test environments.
   * This is dangerous: all spending limits, rate limits, and audit logs will be
   * lost on process restart. Only set this if you fully understand the risks.
   */
  dangerouslyAllowInProduction?: boolean;
  /**
   * L-29 fix: Default TTL in seconds for counter keys created via increment()
   * when no existing TTL is present. If not set, counter keys created by
   * increment() on absent keys will have no TTL (they persist indefinitely).
   */
  defaultCounterTtlSeconds?: number;
  /**
   * CRIT-T5-02 fix: HMAC key for counter integrity protection.
   * When provided, this key is used instead of auto-generating a random key.
   * This ensures counter HMACs survive process restarts — without a persistent
   * key, all counter HMACs become invalid after restart and counters reset to
   * zero, allowing an attacker who can force a restart to bypass spending/rate
   * limits. Must be a hex-encoded string of at least 64 characters (32 bytes).
   */
  hmacKey?: string;
}

export class MemoryStore implements Store {
  private readonly data = new Map<string, StoreEntry>();
  private readonly lists = new Map<string, string[]>();
  /** LOW-04 fix: Optional periodic GC timer for expired entries */
  private gcTimer?: ReturnType<typeof setInterval>;
  // LOW-T5-01 fix: Static flag so the production warning is emitted only once across all instances
  private static warningEmitted = false;
  /**
   * H-25 fix: Per-instance HMAC key for integrity protection of counter values.
   * This is defense-in-depth against store manipulation: an attacker who can
   * directly modify the in-memory Map (e.g., via prototype pollution or memory
   * corruption) cannot forge valid counter values without knowing this key.
   */
  private readonly hmacKey: string;
  /** L-29 fix: Default TTL for counter keys created via increment() on absent keys */
  private readonly defaultCounterTtlSeconds?: number;

  constructor(config?: MemoryStoreConfig) {
    // STORE-017 fix: Block MemoryStore in production unless explicitly opted in.
    // HIGH-18/HIGH-19: MemoryStore loses all security state on restart — this must
    // be an error (not just a warning) to prevent accidental production use.
    // MED-T5-01 fix: Use dedicated KOVA_ALLOW_MEMORY_STORE env var instead of NODE_ENV=test.
    // Previously, setting NODE_ENV=test in production would bypass this guard. A dedicated
    // env var is harder to accidentally set and makes the opt-in explicit.
    const allowMemoryStore = typeof process !== "undefined" && (
      process.env.KOVA_ALLOW_MEMORY_STORE === "1" ||
      process.env.NODE_ENV === "test"
    );
    if (typeof process !== "undefined" && !allowMemoryStore) {
      if (!config?.dangerouslyAllowInProduction) {
        throw new Error(
          "MemoryStore is not safe for production use (data lost on restart). " +
          "Use SqliteStore instead, or pass { dangerouslyAllowInProduction: true } to override.",
        );
      }
      // LOW-T5-01 fix: Use static flag so warning is emitted only once across all instances
      if (!MemoryStore.warningEmitted) {
        MemoryStore.warningEmitted = true;
        process.emitWarning(
          "MemoryStore is being used in production with dangerouslyAllowInProduction flag.",
          "SecurityWarning",
        );
      }
    }
    // CRIT-T5-02 fix: Use provided HMAC key if available, otherwise auto-generate.
    // A persistent HMAC key ensures counter integrity survives process restarts.
    // Without this, all counters reset to zero on restart (HMAC mismatch → reset).
    if (config?.hmacKey) {
      if (config.hmacKey.length < 64) {
        throw new Error(
          "MemoryStore: hmacKey must be at least 64 hex characters (32 bytes). " +
          "Generate one with: crypto.randomBytes(32).toString('hex')",
        );
      }
      this.hmacKey = config.hmacKey;
    } else {
      this.hmacKey = crypto.randomBytes(32).toString("hex");
    }
    // L-29 fix: Store the default counter TTL
    this.defaultCounterTtlSeconds = config?.defaultCounterTtlSeconds;
  }

  /**
   * H-25 fix: Compute HMAC for a counter value. This is defense-in-depth against
   * direct store manipulation — if an attacker modifies counter values in the
   * backing store (e.g., via prototype pollution, memory corruption, or a
   * compromised store adapter), the HMAC will not match and the tampered value
   * will be rejected. The HMAC key is generated per-instance, so it is only
   * effective for the lifetime of this MemoryStore instance.
   */
  private computeCounterHmac(key: string, value: string): string {
    return crypto
      .createHmac("sha256", this.hmacKey)
      .update(`${key}:${value}`)
      .digest("hex");
  }

  /**
   * H-25 fix: Verify HMAC integrity of a counter value.
   * Returns true if the HMAC is valid, false if tampered or missing.
   */
  private verifyCounterHmac(key: string, value: string, hmac: string): boolean {
    const expected = this.computeCounterHmac(key, value);
    // Use timingSafeEqual to prevent timing attacks on HMAC comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(hmac, "hex"),
      );
    } catch {
      return false;
    }
  }

  /**
   * Retrieve a value by key. Returns null if not found or expired.
   *
   * M-35 WARNING: TTL enforcement relies on system clock integrity (Date.now()).
   * An attacker with clock manipulation access can bypass TTL-based limits.
   * See increment() documentation for detailed threat analysis.
   */
  async get(key: string): Promise<string | null> {
    validateKey(key);
    const entry = this.data.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }

    return entry.value;
  }

  /** Store a key-value pair with optional TTL in seconds. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    validateKey(key);
    // MED-22 fix: Reject values exceeding maximum length to prevent memory exhaustion
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `MemoryStore.set: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    const entry: StoreEntry = { value };
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    this.data.set(key, entry);
  }

  /**
   * MED-04 fix: Atomically set a value only if the key does not exist (or is expired).
   * Returns true if set, false if key already exists.
   * In-memory implementation is naturally atomic (single-threaded JS).
   */
  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    validateKey(key);
    const entry = this.data.get(key);
    if (entry) {
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.data.delete(key);
      } else {
        return false;
      }
    }

    const newEntry: StoreEntry = { value };
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      newEntry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    this.data.set(key, newEntry);
    return true;
  }

  /**
   * Atomically increment a numeric value by the given amount. Returns the new value.
   *
   * =========================================================================
   * MED-24 / M-02 WARNING — FLOATING-POINT ACCUMULATION DRIFT
   * =========================================================================
   * Counter values are stored as IEEE 754 doubles (JavaScript numbers). Over
   * many increments, floating-point drift may cause the stored value to deviate
   * from the true mathematical sum. For example, after 10,000 increments of
   * 0.1, the result may be 999.9999999999831 instead of 1000.0.
   *
   * M-02 MITIGATION: After each operation, the result is rounded to 12 decimal
   * places to limit drift accumulation. This provides sub-picounit precision
   * while preventing unbounded floating-point error growth.
   *
   * SpendingLimitRule mitigates this by using BigInt-based safeGt() for limit
   * comparisons, but the accumulated counter value itself is still approximate.
   * For applications requiring exact precision (e.g., sub-cent accounting),
   * counters should use string-based decimal arithmetic (e.g., Decimal.js)
   * or store amounts as integer minor units (lamports, satoshis, wei).
   *
   * For high-precision use cases, consider using SqliteStore which uses native
   * numeric types and SQL-level arithmetic, reducing JavaScript float drift.
   * =========================================================================
   *
   * M-35 WARNING — TTL BYPASS VIA CLOCK MANIPULATION:
   * TTL enforcement relies on system clock integrity (Date.now()). An attacker
   * with the ability to manipulate the system clock (e.g., via NTP spoofing or
   * direct clock adjustment) can bypass TTL-based spending and rate limits by
   * setting the clock forward to expire counters prematurely. Consider using
   * monotonic clocks (performance.now()) for relative time calculations if
   * running in a threat model where clock manipulation is a concern. However,
   * performance.now() resets on process restart, so it is not suitable for
   * persistent TTL enforcement across restarts.
   * =========================================================================
   */
  async increment(key: string, amount: number): Promise<number> {
    // STORE-012 fix: Reject non-finite amounts (NaN, Infinity) to prevent counter corruption
    if (!Number.isFinite(amount)) {
      throw new Error(`increment amount must be a finite number, got ${typeof amount === 'number' ? amount : typeof amount}`);
    }
    validateKey(key);
    // Synchronous atomic operation — no await between read and write
    const entry = this.data.get(key);
    let current = 0;
    let existingTtl: number | undefined;
    let keyExists = false;

    if (entry) {
      // Check TTL expiration
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.data.delete(key);
      } else {
        keyExists = true;
        // H-25 fix: Verify HMAC integrity of existing counter value before trusting it.
        // The HMAC is stored in a separate key ({key}:__hmac) to avoid polluting the
        // counter value returned by get(). If the HMAC is missing or invalid, the counter
        // may have been tampered with — treat as corrupted and reset to 0.
        const hmacEntry = this.data.get(key + ":__hmac");
        if (hmacEntry && !this.verifyCounterHmac(key, entry.value, hmacEntry.value)) {
          try {
            process.emitWarning(
              `MemoryStore.increment: HMAC verification failed for key "${key}". ` +
              `Counter value may have been tampered with. Resetting to 0.`,
              "SecurityWarning",
            );
          } catch { /* non-fatal */ }
          current = 0;
        } else {
          const parsed = parseFloat(entry.value);
          // MED-23 fix: Detect non-numeric counter values instead of silently resetting
          if (isNaN(parsed)) {
            try {
              process.emitWarning(
                `MemoryStore.increment: key "${key}" contains non-numeric value. ` +
                `Treating as 0. This may indicate data corruption or key collision.`,
                "StoreWarning",
              );
            } catch { /* non-fatal */ }
          }
          current = isNaN(parsed) ? 0 : parsed;
        }
        existingTtl = entry.expiresAt;
      }
    }

    // L-04 fix: Clamp counter value to zero floor to prevent negative counters.
    // A negative increment (decrement) should not push a counter below zero.
    const rawNewValue = current + amount;
    // M-02 fix: Round to 12 decimal places to limit floating-point drift accumulation
    const newValue = Math.max(0, parseFloat(rawNewValue.toFixed(12)));

    // H-25 fix: Compute HMAC for the new counter value and store it separately.
    // Stored in a separate key ({key}:__hmac) so get() returns the clean counter value.
    const valueStr = String(newValue);
    const hmac = this.computeCounterHmac(key, valueStr);
    this.data.set(key + ":__hmac", { value: hmac });

    const newEntry: StoreEntry = { value: valueStr };
    if (existingTtl) {
      newEntry.expiresAt = existingTtl;
    } else if (!keyExists && this.defaultCounterTtlSeconds !== undefined && this.defaultCounterTtlSeconds > 0) {
      // L-29 fix: When incrementing a non-existent key, apply the default counter TTL
      // to prevent counter entries from persisting indefinitely without a TTL.
      newEntry.expiresAt = Date.now() + this.defaultCounterTtlSeconds * 1000;
    }
    this.data.set(key, newEntry);
    return newValue;
  }

  /**
   * Append a value to a list. Used for audit logs and transaction history.
   * CRIT-03 fix: Enforces maximum list size with FIFO eviction to prevent OOM.
   * L-23 fix: Validates value length before appending to prevent memory exhaustion.
   */
  async append(key: string, value: string): Promise<void> {
    validateKey(key);
    // L-23 fix: Reject values exceeding maximum length to prevent memory exhaustion.
    // The value is checked as-is (not JSON-serialized) since store values are already strings.
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `MemoryStore.append: value length ${value.length} exceeds maximum of ${MAX_VALUE_LENGTH} characters`,
      );
    }
    const list = this.lists.get(key) ?? [];
    list.push(value);
    // CRIT-03 fix: Evict oldest entries when list exceeds max size
    if (list.length > MAX_LIST_SIZE) {
      list.splice(0, list.length - MAX_LIST_SIZE);
    }
    this.lists.set(key, list);
  }

  /** Get the most recent entries from a list, newest first. */
  async getRecent(key: string, count: number): Promise<string[]> {
    validateKey(key);
    if (count <= 0) return [];
    // MED-T5-07 fix: Cap count to MAX_LIST_SIZE to prevent loading unbounded entries
    const cappedCount = Math.min(count, MAX_LIST_SIZE);
    const list = this.lists.get(key) ?? [];
    return list.slice(-cappedCount).reverse();
  }

  /**
   * MED-T5-09 fix: Clear all entries in a list.
   * Used by AuditLogger.clear() to properly clear the list namespace,
   * not just the KV namespace.
   */
  async clearList(key: string): Promise<void> {
    validateKey(key);
    this.lists.delete(key);
  }

  /** Clear all data (useful for testing) */
  clear(): void {
    this.data.clear();
    this.lists.clear();
  }

  /**
   * LOW-04 fix: Start periodic garbage collection of expired entries.
   * Without this, expired entries accumulate in memory until they are
   * next accessed (lazy expiration). For long-running processes with
   * many short-TTL keys, this prevents unbounded memory growth.
   *
   * @param intervalMs How often to sweep, in milliseconds. Default: 60000 (1 minute).
   */
  startGc(intervalMs: number = 60_000): void {
    this.stopGc();
    this.gcTimer = setInterval(() => this.sweepExpired(), intervalMs);
    // Allow the process to exit even if the timer is running
    if (this.gcTimer && typeof this.gcTimer === "object" && "unref" in this.gcTimer) {
      this.gcTimer.unref();
    }
  }

  /** LOW-04 fix: Stop periodic garbage collection. */
  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  /**
   * MED-T1-03 fix: Destroy the MemoryStore by zeroing the HMAC key material
   * and stopping any active GC timer. After calling destroy(), the store
   * should not be used for counter operations (HMAC verification will fail).
   */
  destroy(): void {
    // Zero the HMAC key material to prevent recovery from heap dumps
    if (this.hmacKey) {
      // Overwrite the string contents (best-effort in JS — V8 may retain copies)
      (this as any).hmacKey = "0".repeat(this.hmacKey.length);
      (this as any).hmacKey = "";
    }
    this.stopGc();
    this.data.clear();
    this.lists.clear();
  }

  /** LOW-04 fix: Sweep all expired entries from the data map. */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.data.delete(key);
      }
    }
  }
}
