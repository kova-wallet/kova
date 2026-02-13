/**
 * AuditLogger — Records all policy decisions and transactions with hash chain integrity.
 *
 * S6 enhancements:
 * - S1-01 fix: log() returns Promise<boolean>. After N consecutive write failures,
 *   throws AuditCircuitOpenError. Wallet checks isCircuitOpen() before executing.
 * - S1-11 fix: Each audit entry stores SHA-256 hash of previous entry.
 *   verifyIntegrity() walks chain to detect tampering/gaps.
 * - Backward-compatible constructor: accepts Store (legacy) or AuditLoggerConfig.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { AuditEntry } from "./types.js";
import type { Store } from "../stores/interface.js";

/** Callback invoked when an audit log write fails */
export type AuditFailureCallback = (error: unknown, consecutiveFailures: number) => void;

/** Configuration for the enhanced AuditLogger */
export interface AuditLoggerConfig {
  /** The store for persisting audit entries */
  store: Store;
  /** Maximum consecutive failures before circuit opens. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Callback invoked on each write failure */
  onAuditFailure?: AuditFailureCallback;
}

/** Thrown when the audit circuit breaker is open (too many consecutive write failures) */
export class AuditCircuitOpenError extends Error {
  constructor(consecutiveFailures: number) {
    super(
      `Audit circuit breaker open: ${consecutiveFailures} consecutive write failures. ` +
      `Transactions are blocked until audit logging is restored.`,
    );
    this.name = "AuditCircuitOpenError";
  }
}

/** Result of an integrity verification check */
export interface IntegrityReport {
  /** Whether the entire chain is valid */
  valid: boolean;
  /** Total entries checked */
  entriesChecked: number;
  /** Index of the first broken link (0-based from oldest), or -1 if valid */
  firstBrokenAt: number;
  /** Description of the integrity issue, if any */
  error?: string;
}

/**
 * Canonical JSON serialization with recursively sorted keys.
 * HIGH-01 fix: Recursively sorts ALL levels (not just top-level) for deterministic hashing.
 * Ensures hash computation is identical across JS engines and serialization round-trips.
 */
function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}

/** Recursively sort object keys at all levels */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * HIGH-02 fix: Constant-time hash comparison to prevent timing side-channel attacks.
 * Uses crypto.timingSafeEqual to prevent byte-by-byte hash forgery.
 */
function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** MED-04 fix: Domain separator for hash chain computation to prevent length extension attacks */
const HASH_DOMAIN_SEPARATOR = "\x00kova:audit:v1\x00";

export class AuditLogger {
  private readonly store: Store;
  private readonly storeKey = "audit:log";
  private readonly maxConsecutiveFailures: number;
  private readonly onAuditFailure?: AuditFailureCallback;
  private consecutiveFailures = 0;
  /** MED-12 fix: Mutex to serialize log() calls and prevent hash chain corruption */
  private logLock: Promise<void> = Promise.resolve();

  /**
   * Backward-compatible constructor.
   * Accepts either a Store (legacy) or AuditLoggerConfig object.
   */
  constructor(storeOrConfig: Store | AuditLoggerConfig) {
    if ("get" in storeOrConfig && "set" in storeOrConfig && !("store" in storeOrConfig)) {
      // Legacy: bare Store passed directly
      this.store = storeOrConfig as Store;
      this.maxConsecutiveFailures = 3;
    } else {
      // New config object
      const config = storeOrConfig as AuditLoggerConfig;
      this.store = config.store;
      this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
      this.onAuditFailure = config.onAuditFailure;
    }

    if (this.maxConsecutiveFailures < 1) {
      throw new Error("maxConsecutiveFailures must be at least 1");
    }
  }

  /**
   * Log an audit entry with hash chain integrity.
   *
   * S1-01 fix: Returns true on success, false on failure.
   * After maxConsecutiveFailures consecutive failures, throws AuditCircuitOpenError.
   * MED-12 fix: Serialized via mutex to prevent concurrent hash chain corruption.
   */
  async log(entry: AuditEntry): Promise<boolean> {
    // Check if circuit is already open (before acquiring lock)
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new AuditCircuitOpenError(this.consecutiveFailures);
    }

    // MED-12 fix: Serialize log() calls to prevent concurrent writes corrupting the hash chain
    let releaseLock: () => void;
    const previousLock = this.logLock;
    this.logLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    await previousLock;

    try {
      return await this.logInternal(entry);
    } finally {
      releaseLock!();
    }
  }

  /** Internal log implementation (called under mutex) */
  private async logInternal(entry: AuditEntry): Promise<boolean> {
    try {
      // Derive previous hash from the most recent entry in the list
      let previousHash = "";
      const recentRaw = await this.store.getRecent(this.storeKey, 1);
      if (recentRaw.length > 0) {
        try {
          const lastEntry = JSON.parse(recentRaw[0]!) as AuditEntry;
          previousHash = lastEntry.hash ?? "";
        } catch {
          // Corrupted last entry — start a new chain segment
        }
      }

      // HIGH-01 fix: Use recursive canonical JSON for deterministic hash computation
      // MED-04 fix: Use domain separator to prevent length extension / collision attacks
      const entryJson = canonicalJson(entry);
      const hash = createHash("sha256")
        .update(entryJson + HASH_DOMAIN_SEPARATOR + previousHash)
        .digest("hex");

      // Create the enriched entry with hash chain fields
      const enrichedEntry: AuditEntry = {
        ...entry,
        hash,
        previousHash: previousHash || undefined,
      };

      // Single atomic write
      await this.store.append(this.storeKey, JSON.stringify(enrichedEntry));

      // Success: reset failure counter
      this.consecutiveFailures = 0;
      return true;
    } catch (err) {
      this.consecutiveFailures++;
      this.onAuditFailure?.(err, this.consecutiveFailures);
      return false;
    }
  }

  /** Get recent audit entries. Skips corrupted entries gracefully. */
  async getRecent(count: number = 10): Promise<AuditEntry[]> {
    const raw = await this.store.getRecent(this.storeKey, count);
    const entries: AuditEntry[] = [];
    for (const r of raw) {
      try {
        entries.push(JSON.parse(r) as AuditEntry);
      } catch {
        // Skip corrupted entries — don't let bad data block audit access
      }
    }
    return entries;
  }

  /** Check if the audit circuit breaker is open (too many consecutive failures) */
  isCircuitOpen(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /** Get the current consecutive failure count */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** Reset the failure counter (e.g., after manual intervention) */
  resetFailureCount(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Verify the integrity of the hash chain.
   * Walks the chain forward from oldest to newest, checking each hash.
   * HIGH-02 fix: Uses timing-safe comparison for all hash checks.
   * MED-04 fix: Uses domain separator in hash recomputation.
   *
   * @param count Number of recent entries to check (default: 100)
   */
  async verifyIntegrity(count: number = 100): Promise<IntegrityReport> {
    const raw = await this.store.getRecent(this.storeKey, count);

    if (raw.length === 0) {
      return { valid: true, entriesChecked: 0, firstBrokenAt: -1 };
    }

    // getRecent returns newest-first; reverse to walk oldest-first
    const entries: AuditEntry[] = [];
    for (const r of raw) {
      try {
        entries.push(JSON.parse(r) as AuditEntry);
      } catch {
        return {
          valid: false,
          entriesChecked: entries.length,
          firstBrokenAt: entries.length,
          error: "Corrupted entry: failed to parse JSON",
        };
      }
    }
    entries.reverse();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // Every entry must have a hash
      if (!entry.hash || typeof entry.hash !== "string" || entry.hash.length !== 64) {
        return {
          valid: false,
          entriesChecked: i,
          firstBrokenAt: i,
          error: `Entry ${i} is missing or has invalid hash field`,
        };
      }

      // Verify previous hash link (HIGH-02: timing-safe comparison)
      if (i > 0) {
        const prevEntry = entries[i - 1]!;
        if (!entry.previousHash || !prevEntry.hash || !safeHashEquals(entry.previousHash, prevEntry.hash)) {
          return {
            valid: false,
            entriesChecked: i,
            firstBrokenAt: i,
            error: `Entry ${i} previousHash does not match entry ${i - 1} hash`,
          };
        }
      }

      // Verify the hash itself: recompute from entry content
      // Strip hash and previousHash fields, then recompute using canonical JSON
      const { hash: _storedHash, previousHash: prevHash, ...entryContent } = entry;
      void _storedHash;
      const entryJson = canonicalJson(entryContent);
      // MED-04 fix: Use domain separator in hash recomputation (must match log())
      const expectedHash = createHash("sha256")
        .update(entryJson + HASH_DOMAIN_SEPARATOR + (prevHash ?? ""))
        .digest("hex");

      // HIGH-02 fix: Timing-safe hash comparison
      if (!safeHashEquals(entry.hash, expectedHash)) {
        return {
          valid: false,
          entriesChecked: i,
          firstBrokenAt: i,
          error: `Entry ${i} hash does not match recomputed hash (tampered or corrupted)`,
        };
      }
    }

    return { valid: true, entriesChecked: entries.length, firstBrokenAt: -1 };
  }
}
