/**
 * MemoryStore — In-memory store for development and testing.
 * All data is lost when the process exits.
 * TTL expiration is checked on read (lazy expiration).
 */

import type { Store } from "./interface.js";

interface StoreEntry {
  value: string;
  expiresAt?: number;
}

/** CRIT-03 fix: Maximum entries per list to prevent unbounded memory growth */
const MAX_LIST_SIZE = 100_000;

export class MemoryStore implements Store {
  private readonly data = new Map<string, StoreEntry>();
  private readonly lists = new Map<string, string[]>();

  /** Retrieve a value by key. Returns null if not found or expired. */
  async get(key: string): Promise<string | null> {
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
    const entry: StoreEntry = { value };
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    this.data.set(key, entry);
  }

  /** Atomically increment a numeric value by the given amount. Returns the new value. */
  async increment(key: string, amount: number): Promise<number> {
    // Synchronous atomic operation — no await between read and write
    const entry = this.data.get(key);
    let current = 0;
    let existingTtl: number | undefined;

    if (entry) {
      // Check TTL expiration
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.data.delete(key);
      } else {
        const parsed = parseFloat(entry.value);
        current = isNaN(parsed) ? 0 : parsed;
        existingTtl = entry.expiresAt;
      }
    }

    const newValue = current + amount;
    const newEntry: StoreEntry = { value: String(newValue) };
    if (existingTtl) {
      newEntry.expiresAt = existingTtl;
    }
    this.data.set(key, newEntry);
    return newValue;
  }

  /**
   * Append a value to a list. Used for audit logs and transaction history.
   * CRIT-03 fix: Enforces maximum list size with FIFO eviction to prevent OOM.
   */
  async append(key: string, value: string): Promise<void> {
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
    if (count <= 0) return [];
    const list = this.lists.get(key) ?? [];
    return list.slice(-count).reverse();
  }

  /** Clear all data (useful for testing) */
  clear(): void {
    this.data.clear();
    this.lists.clear();
  }
}
