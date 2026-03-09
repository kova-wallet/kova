/**
 * PrefixedStore — Wraps a Store implementation with a key prefix.
 *
 * HIGH-08 fix: Prevents store key collisions when multiple AgentWallet instances
 * share the same Store backend. Each wallet should use a unique prefix
 * (e.g., derived from the signer's public key) so that spending limits,
 * rate limits, circuit breakers, and audit logs are isolated per-wallet.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  STORE-005 WARNING — MULTI-WALLET ISOLATION                        ║
 * ║                                                                     ║
 * ║  When multiple AgentWallet instances share a Store backend, you     ║
 * ║  MUST wrap each wallet's store with PrefixedStore to prevent        ║
 * ║  cross-wallet interference. Without prefixing:                      ║
 * ║    - Spending limits are shared (wallet A's spend counts toward B)  ║
 * ║    - Rate limit counters collide (one wallet exhausts another's)    ║
 * ║    - Circuit breaker state bleeds across wallets                    ║
 * ║    - Audit logs from different wallets are interleaved              ║
 * ║    - Idempotency keys may collide across wallets                   ║
 * ║                                                                     ║
 * ║  Use PrefixedStore.wrapIfNeeded(store, prefix) for convenience.    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   const store = new MemoryStore();
 *   const walletStore = new PrefixedStore(store, "wallet:GsbwXfJr...:");
 *   const wallet = new AgentWallet({ store: walletStore, ... });
 *
 *   // Or use the convenience factory:
 *   const walletStore = PrefixedStore.wrapIfNeeded(store, "wallet:GsbwXfJr...:");
 */

import type { Store } from "./interface.js";

/**
 * HIGH-24 fix: Delimiter character appended to prefix to prevent namespace collisions.
 * Without a delimiter, prefix "ab" + key "cd" === prefix "a" + key "bcd", which would
 * cause two different PrefixedStore instances to read/write each other's keys.
 * Using "|" as a delimiter (not valid in base58 or UUIDs) ensures isolation.
 */
const PREFIX_DELIMITER = "|";

/** STORE-016 fix: Maximum prefix length to prevent excessively long keys */
const MAX_PREFIX_LENGTH = 64;

/** L-22 fix: Maximum combined key length (prefix + delimiter + key) to prevent
 * excessively long keys that could cause issues with underlying store backends
 * (e.g., SQLite index performance degradation, MemoryStore memory waste). */
const MAX_COMBINED_KEY_LENGTH = 1024;

/** STORE-016 fix: Allowed prefix characters — alphanumeric, underscore, hyphen, colon */
const PREFIX_PATTERN = /^[a-zA-Z0-9_\-:]+$/;

/**
 * DATA-013 SECURITY NOTE: The `__hmac` key blocking in validateCombinedKeyLength()
 * prevents callers from directly accessing HMAC entries through PrefixedStore. However,
 * the `increment()` method delegates to the inner store which writes `{prefix}|{key}:__hmac`
 * internally. Anyone retaining a reference to the inner store can bypass prefix isolation
 * and access HMAC keys for any prefix. DO NOT share or expose the inner store reference
 * after wrapping it with PrefixedStore.
 */
export class PrefixedStore implements Store {
  // AUDIT-L-13: Inner store reference bypass. Ensure inner store is not exposed after wrapping.
  private readonly inner: Store;
  private readonly prefix: string;

  constructor(store: Store, prefix: string) {
    // HIGH-10 fix: Validate prefix to prevent misconfigured store isolation.
    // (1) Prefix must be non-empty (at least 1 character before the delimiter).
    // (2) Prefix must not contain the delimiter character "|" to avoid ambiguity
    //     in key parsing and accidental namespace collisions.
    if (!prefix || prefix.length < 1) {
      throw new Error(
        "PrefixedStore: prefix must be a non-empty string (at least 1 character). " +
        "Use a unique identifier such as the signer's public key.",
      );
    }
    // STORE-016 fix: Validate prefix length (1-64 chars) and character set
    if (prefix.length > MAX_PREFIX_LENGTH) {
      throw new Error(
        `PrefixedStore: prefix length ${prefix.length} exceeds maximum of ${MAX_PREFIX_LENGTH} characters.`,
      );
    }
    if (!PREFIX_PATTERN.test(prefix)) {
      throw new Error(
        `PrefixedStore: prefix contains invalid characters. ` +
        `Only alphanumeric, underscore, hyphen, and colon are allowed. Received: "${prefix}"`,
      );
    }
    if (prefix.includes(PREFIX_DELIMITER)) {
      throw new Error(
        `PrefixedStore: prefix must not contain the delimiter character "${PREFIX_DELIMITER}". ` +
        `Received: "${prefix}"`,
      );
    }

    this.inner = store;
    // HIGH-24 fix: Ensure prefix ends with delimiter for clean namespace isolation
    this.prefix = prefix + PREFIX_DELIMITER;
  }

  /**
   * L-22 fix: Validate that the combined key (prefix + key) does not exceed
   * the maximum allowed length. This prevents excessively long keys from
   * degrading performance or causing errors in the underlying store.
   *
   * MED-T5-03 fix: Also rejects keys that attempt to access internal `__hmac`
   * keys belonging to other prefixes. If the inner store reference leaks,
   * an attacker could forge HMAC values for other wallets' counters by writing
   * directly to `{otherPrefix}|someKey:__hmac` via the unprefixed inner store.
   * This check prevents PrefixedStore from being used to access HMAC keys
   * outside its own prefix namespace.
   */
  private validateCombinedKeyLength(key: string): string {
    // MED-T5-03 fix: Block access to internal __hmac keys via crafted key names.
    // The HMAC keys are internal to the store's counter integrity system and should
    // only be accessed by the store's own increment() method, not by callers.
    if (key.includes(":__hmac") || key.endsWith(":__hmac")) {
      throw new Error(
        "PrefixedStore: direct access to internal __hmac keys is not allowed. " +
        "HMAC keys are managed internally by the store's increment() method.",
      );
    }
    const combinedKey = this.prefix + key;
    if (combinedKey.length > MAX_COMBINED_KEY_LENGTH) {
      throw new Error(
        `PrefixedStore: combined key length ${combinedKey.length} exceeds maximum of ${MAX_COMBINED_KEY_LENGTH}. ` +
        `Prefix length: ${this.prefix.length}, key length: ${key.length}.`,
      );
    }
    return combinedKey;
  }

  /**
   * STORE-005 fix: Factory method that wraps a store with a prefix if one is provided,
   * or returns the original store if no prefix is given. This simplifies call sites
   * and avoids forgetting to wrap stores.
   *
   * RECOMMENDATION: AgentWallet should always wrap stores with a prefix derived from
   * the signer's public key to ensure per-wallet isolation of spending limits, rate
   * counters, circuit breaker state, and audit logs. Failing to prefix when multiple
   * wallets share a store backend will cause cross-wallet interference.
   *
   * NOTE: AgentWallet's constructor does NOT enforce PrefixedStore usage because
   * enforcing it would be a breaking change for single-wallet deployments. However,
   * any multi-wallet deployment MUST use this method (or the PrefixedStore constructor
   * directly) to avoid the cross-wallet issues described in the class-level warning.
   *
   * @param store - The underlying store to optionally wrap
   * @param prefix - If provided, wraps the store with this prefix. If omitted or
   *                 empty, returns the original store unchanged.
   * @returns A PrefixedStore if prefix is provided, or the original store if not.
   */
  static wrapIfNeeded(store: Store, prefix?: string): Store {
    if (prefix) {
      return new PrefixedStore(store, prefix);
    }
    return store;
  }

  async get(key: string): Promise<string | null> {
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.get(combinedKey);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    // MED-08 fix: Validate ttlSeconds before delegating to inner store.
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`PrefixedStore.set: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.set(combinedKey, value, ttlSeconds);
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    // MED-08 fix: Validate ttlSeconds before delegating to inner store.
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`PrefixedStore.setIfNotExists: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.setIfNotExists(combinedKey, value, ttlSeconds);
  }

  async increment(key: string, amount: number): Promise<number> {
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.increment(combinedKey, amount);
  }

  async append(key: string, value: string): Promise<void> {
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.append(combinedKey, value);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    const combinedKey = this.validateCombinedKeyLength(key);
    return this.inner.getRecent(combinedKey, count);
  }

  /**
   * MED-T5-09 fix: Clear all entries in a list via the inner store's clearList.
   * Delegates to the inner store if it implements clearList.
   */
  async clearList(key: string): Promise<void> {
    const combinedKey = this.validateCombinedKeyLength(key);
    if (typeof this.inner.clearList === "function") {
      return this.inner.clearList(combinedKey);
    }
  }
}
