/**
 * SqliteStore — Persistent store using better-sqlite3.
 *
 * Uses two tables:
 * - `kv` for key-value pairs with optional TTL expiration
 * - `lists` for append/getRecent operations (transaction logs)
 *
 * TTL expiration is lazy (checked on read), matching MemoryStore behavior.
 */

import Database from "better-sqlite3";
import type { Store } from "./interface.js";

/** CRIT-03 fix: Maximum entries per list key to prevent unbounded disk growth */
const MAX_LIST_SIZE = 100_000;

export interface SqliteStoreConfig {
  /** Path to the SQLite database file. Use ":memory:" for in-memory testing. */
  path: string;
}

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  /** Create a new SqliteStore. Opens (or creates) the database at the given path. */
  constructor(config: SqliteStoreConfig) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS lists (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE INDEX IF NOT EXISTS idx_lists_key_id ON lists(key, id DESC);
    `);
  }

  /** Retrieve a value by key. Returns null if not found or expired. */
  async get(key: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value, expires_at FROM kv WHERE key = ?")
      .get(key) as { value: string; expires_at: number | null } | undefined;

    if (!row) return null;

    if (row.expires_at !== null && Date.now() > row.expires_at) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      return null;
    }

    return row.value;
  }

  /** Store a key-value pair with optional TTL in seconds. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds !== undefined && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null;

    this.db
      .prepare(
        "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
      )
      .run(key, value, expiresAt);
  }

  /** Atomically increment a numeric value by the given amount. Returns the new value. */
  async increment(key: string, amount: number): Promise<number> {
    const result = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT value, expires_at FROM kv WHERE key = ?")
        .get(key) as { value: string; expires_at: number | null } | undefined;

      let current = 0;
      let expiresAt: number | null = null;

      if (existing) {
        if (existing.expires_at !== null && Date.now() > existing.expires_at) {
          // Expired — treat as fresh
          this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
        } else {
          const parsed = parseFloat(existing.value);
          current = isNaN(parsed) ? 0 : parsed;
          expiresAt = existing.expires_at;
        }
      }

      const newValue = current + amount;
      this.db
        .prepare(
          "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
        )
        .run(key, String(newValue), expiresAt);

      return newValue;
    })();

    return result;
  }

  /**
   * Append a value to a list. Used for audit logs and transaction history.
   * CRIT-03 fix: Evicts oldest entries when list exceeds MAX_LIST_SIZE.
   */
  async append(key: string, value: string): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO lists (key, value, created_at) VALUES (?, ?, ?)",
        )
        .run(key, value, Date.now());

      // CRIT-03 fix: Evict oldest entries when list exceeds max size
      const countRow = this.db
        .prepare("SELECT COUNT(*) as cnt FROM lists WHERE key = ?")
        .get(key) as { cnt: number };

      if (countRow.cnt > MAX_LIST_SIZE) {
        const excess = countRow.cnt - MAX_LIST_SIZE;
        this.db
          .prepare(
            "DELETE FROM lists WHERE key = ? AND id IN (SELECT id FROM lists WHERE key = ? ORDER BY id ASC LIMIT ?)",
          )
          .run(key, key, excess);
      }
    })();
  }

  /** Get the most recent entries from a list, newest first. */
  async getRecent(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];

    const rows = this.db
      .prepare(
        "SELECT value FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(key, count) as { value: string }[];

    return rows.map((r) => r.value);
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /** Delete all data (for testing) */
  clear(): void {
    this.db.exec("DELETE FROM kv; DELETE FROM lists;");
  }
}
