/**
 * Store interface — pluggable persistence for spending counters, rate limits, and tx logs.
 * Deliberately minimal (7 operations) to make adapters trivial to implement.
 *
 * HIGH-25 KEY-SCOPING REQUIREMENTS:
 * When multiple AgentWallet instances share the same Store backend, keys from
 * different wallets MUST be isolated. Use PrefixedStore to wrap the base store
 * with a per-wallet prefix (derived from the signer's public key):
 *
 *   const baseStore = new SqliteStore({ path: "./wallet.db", requireEncryption: true });
 *   const walletStore = new PrefixedStore(baseStore, `wallet:${signerAddress}`);
 *   const wallet = new AgentWallet({ store: walletStore, ... });
 *
 * Without PrefixedStore, multiple wallets sharing a store will interfere with
 * each other's spending limits, rate counters, circuit breaker state, and audit logs.
 *
 * Internal key conventions used by the SDK:
 * - "spending:{window}:{token}" — spending limit counters (SpendingLimitRule)
 * - "spending:{window}:USD" — USD-denominated spending counters
 * - "ratelimit:{window}" — rate limit counters (RateLimitRule)
 * - "idempotency:{intentId}:{hash}" — idempotency cache (AgentWallet)
 * - "circuit_breaker:*" — circuit breaker state (CircuitBreaker)
 * - "read_ops:minute" — read operation rate limiter (AgentWallet)
 * - "audit_log" — audit log entries list (AuditLogger)
 */

export interface Store {
  /** Get a value by key. Returns null if not found. */
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL (in seconds). */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /**
   * MED-04 fix: Atomically set a value only if the key does not exist (or is expired).
   * Returns true if the value was set, false if the key already exists.
   * This prevents TOCTOU races in ensureKeyWithTTL where concurrent calls
   * to get() + set() could reset a counter's TTL.
   */
  setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean>;

  /** Atomically increment a numeric value. Returns the new value. Creates key with initial value if not exists. */
  increment(key: string, amount: number): Promise<number>;

  /** Append an entry to a list (for transaction logs). */
  append(key: string, value: string): Promise<void>;

  /** Get the most recent N entries from a list. */
  getRecent(key: string, count: number): Promise<string[]>;

  /** Clear all entries in a list (for audit log clearing, GC, etc.). */
  clearList(key: string): Promise<void>;
}
