/**
 * Store interface — pluggable persistence for spending counters, rate limits, and tx logs.
 * Deliberately minimal (5 operations) to make adapters trivial to implement.
 */

export interface Store {
  /** Get a value by key. Returns null if not found. */
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL (in seconds). */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Atomically increment a numeric value. Returns the new value. Creates key with initial value if not exists. */
  increment(key: string, amount: number): Promise<number>;

  /** Append an entry to a list (for transaction logs). */
  append(key: string, value: string): Promise<void>;

  /** Get the most recent N entries from a list. */
  getRecent(key: string, count: number): Promise<string[]>;
}
