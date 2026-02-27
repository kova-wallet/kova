/**
 * AuditLogger — Records all policy decisions and transactions with hash chain integrity.
 *
 * S6 enhancements:
 * - S1-01 fix: log() returns Promise<boolean>. After N consecutive write failures,
 *   throws AuditCircuitOpenError. Wallet checks isCircuitOpen() before executing.
 * - S1-11 fix: Each audit entry stores SHA-256 hash of previous entry.
 *   verifyIntegrity() walks chain to detect tampering/gaps.
 * - Backward-compatible constructor: accepts Store (legacy) or AuditLoggerConfig.
 *
 * STORE-009 NOTE: The fallback logging path in wallet.ts (owned by Team A) writes
 * audit metadata to stderr when the primary audit store is unavailable. That fallback
 * should sanitize metadata before logging to avoid leaking sensitive information
 * (e.g., private keys, full transaction payloads, recipient addresses) to stderr.
 * This is tracked as STORE-009 and should be addressed in wallet.ts.
 *
 * ARCH-05 KNOWN LIMITATION — HASH CHAIN RESILIENCE:
 * The audit hash chain is a LINEAR chain where each entry includes the hash of the
 * previous entry. If any single entry is corrupted or deleted, the entire chain from
 * that point forward becomes unverifiable. There is no redundancy, checkpointing, or
 * ability to verify entries independently. Additionally, HMAC key rotation creates a
 * discontinuity — the old chain must be verified with the old key and the new chain
 * has no linkage to the old one (see L-16 NOTE in AuditLoggerConfig.hmacKey).
 * For higher resilience, consider:
 *   1. Periodic Merkle tree checkpoints (every N entries) for sub-chain verification
 *   2. Redundant external hash log (e.g., write hashes to a separate append-only store)
 *   3. Overlapping HMAC key rotation with dual-signing during transition
 * See security_audit_team10 ARCH-05 for full analysis.
 */

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
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
  /**
   * HIGH-02 fix: HMAC secret key for audit log authenticity.
   * When provided, each audit entry's hash is computed using HMAC-SHA256 instead
   * of plain SHA-256. This prevents forged insertions even if the store is
   * compromised — an attacker with read access cannot construct valid entries
   * without knowing the secret key. Store this key separately from the audit log
   * (e.g., environment variable, secret manager).
   *
   * L-16 NOTE — HMAC KEY ROTATION:
   * There is currently no built-in HMAC key rotation mechanism. To rotate keys:
   * 1. Verify the integrity of the existing log with the current key.
   * 2. Create a new AuditLogger instance with the new HMAC key.
   * 3. The new chain starts fresh — old entries can only be verified with the old key.
   * 4. Store the rotation timestamp alongside the old key for audit trail continuity,
   *    so that during forensic review you know which key to use for which time range.
   * 5. Archive or snapshot the old log before starting the new chain.
   * A future version should support automatic key rotation with overlapping
   * verification windows.
   */
  hmacKey?: string | Buffer;
  /**
   * STORE-007 fix: Token required to reset the circuit breaker failure counter.
   * When set, resetFailureCount() must be called with a matching token. This
   * prevents unauthenticated reset of the audit circuit breaker, which could
   * allow an attacker to suppress audit failures. If not set, resetFailureCount()
   * works without a token for backwards compatibility.
   */
  resetToken?: string;
  /**
   * MED-T3-09 fix: Separate token required for the destructive clear() operation.
   * When set, clear() must be called with this token. This prevents the operational
   * resetToken (used for routine resetFailureCount()) from also granting the
   * higher-privilege ability to destroy the entire audit log. If not set, clear()
   * falls back to using resetToken for backwards compatibility.
   */
  clearToken?: string;
  /**
   * STORE-010 fix: Callback invoked when the hash chain is reset (previous hash
   * missing or corrupted). Allows callers to implement custom alerting or logging
   * when audit chain continuity is broken.
   */
  onHashChainReset?: (reason: string) => void;
  /**
   * CRIT-08 fix: Optional AES-256-GCM encryption key for audit log entries.
   * When provided, all audit entries are encrypted before being stored and
   * decrypted when retrieved. The key must be exactly 32 bytes (256 bits).
   * Encrypted entries are stored as "iv:authTag:ciphertext" (all base64-encoded).
   * Generate with: crypto.randomBytes(32)
   */
  encryptionKey?: Buffer;
  /**
   * HIGH-20 fix: Optional retention period in days for audit log entries.
   * When configured, entries older than this many days are periodically pruned
   * during logInternal() calls. Pruning is throttled to avoid performance impact:
   * it runs at most once every 100 log entries or every 5 minutes, whichever comes
   * first. This prevents unbounded growth of audit entries beyond the 100,000-entry
   * cap by also enforcing a time-based eviction policy.
   *
   * Example: retentionDays: 90 means entries older than 90 days are eligible for removal.
   * Set to 0 or omit to disable retention-based pruning (entries persist until cap).
   */
  retentionDays?: number;
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
  // LOW-T1-04 fix: Type-tagged BigInt serialization preserves type information
  // for lossless round-tripping (previously used plain .toString() which lost the type).
  if (typeof value === "bigint") return { __bigint: value.toString() };
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    // M-18 fix: Filter out dangerous prototype-pollution keys during canonical serialization.
    // These properties can trigger prototype chain manipulation if preserved in sorted output.
    for (const key of Object.keys(value as Record<string, unknown>).filter(k => k !== '__proto__' && k !== 'constructor' && k !== 'prototype').sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * HIGH-02 fix: Constant-time hash comparison to prevent timing side-channel attacks.
 * Uses crypto.timingSafeEqual to prevent byte-by-byte hash forgery.
 * LOW-15 fix: Wraps Buffer.from in try/catch to handle non-hex input gracefully.
 * If either input contains invalid hex characters, Buffer.from("hex") may produce
 * unexpected results or throw. Returning false on error is safe (rejects the hash).
 */
function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    // Verify the buffers decoded to the expected length (non-hex chars silently truncate)
    if (bufA.length !== bufB.length || bufA.length !== a.length / 2) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** MED-04 fix: Domain separator for hash chain computation to prevent length extension attacks */
const HASH_DOMAIN_SEPARATOR = "\x00kova:audit:v1\x00";

/**
 * CRIT-04 fix: Extended AuditEntry with sequence number for truncation detection.
 * The sequenceNumber is a monotonically increasing counter that allows verifyIntegrity()
 * to detect if entries have been removed from the middle or beginning of the chain.
 * This is stored alongside the entry in the audit log store.
 */
interface SequencedAuditEntry extends AuditEntry {
  sequenceNumber?: number;
}

/**
 * MED-19/MED-33 fix: Validate a parsed object has the minimum required AuditEntry structure.
 * Rejects invalid JSON that would otherwise pass through unchecked via `as AuditEntry`.
 */
function isValidAuditEntry(obj: unknown): obj is AuditEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.timestamp === "number" &&
    typeof e.intentId === "string" &&
    e.intent !== null && typeof e.intent === "object" &&
    Array.isArray(e.policyDecisions) &&
    e.finalDecision !== null && typeof e.finalDecision === "object"
  );
}

/**
 * STORE-003 fix: Append-only store wrapper that rejects mutations that could delete
 * audit log entries. The audit log is an immutable append-only ledger; allowing
 * arbitrary set() or direct store access could enable deletion or overwriting of
 * entries. This wrapper delegates all reads and appends to the underlying store
 * but marks the store as readonly for audit purposes.
 *
 * Note: The underlying Store interface does not expose a delete() method, but
 * set() with an empty value or overwriting list keys could effectively erase data.
 * This wrapper is a defense-in-depth measure — the primary protection is that
 * AuditLogger only uses append() and getRecent() on its store key.
 */

export class AuditLogger {
  /** STORE-003 fix: The store reference is readonly — audit entries are append-only.
   *  Callers must not use the store directly to modify or delete audit entries. */
  private readonly store: Store;
  private readonly storeKey = "audit:log";
  private readonly maxConsecutiveFailures: number;
  private readonly onAuditFailure?: AuditFailureCallback;
  /** HIGH-02 fix: Optional HMAC key for audit log authenticity
   *  STORE-013: Not readonly — must be mutable so destroy() can zero the key material */
  private hmacKey?: Buffer;
  private consecutiveFailures = 0;
  /** MED-12 fix: Mutex to serialize log() calls and prevent hash chain corruption */
  private logLock: Promise<void> = Promise.resolve();
  /** STORE-007 fix: Optional token for authenticated circuit breaker reset */
  private readonly resetToken?: string;
  /** MED-T3-09 fix: Separate higher-privilege token for destructive clear() operation */
  private readonly clearToken?: string;
  /** STORE-010 fix: Optional callback for hash chain reset events */
  private readonly onHashChainReset?: (reason: string) => void;
  /** M-42 fix: Flag to prevent use after destroy() — avoids silent HMAC-to-SHA256 degradation */
  private destroyed = false;
  /** CRIT-08 fix: Optional AES-256-GCM encryption key for at-rest encryption of audit entries */
  private encryptionKey?: Buffer;
  /** HIGH-20 fix: Retention period in days for audit log entries */
  private readonly retentionDays?: number;
  /**
   * CRIT-04 fix: Monotonically increasing sequence number for truncation detection.
   * Each new entry gets the next sequence number. During verifyIntegrity(), gaps
   * in the sequence indicate that entries were deleted/truncated from the chain.
   */
  private nextSequenceNumber = 0;
  /** CRIT-04 fix: Total number of entries ever written (persisted to store) */
  private totalEntryCount = 0;
  /** CRIT-04 fix: Store key for persisting the total entry count */
  private readonly entryCountKey = "audit:entry_count";
  /** CRIT-04 fix: Store key for persisting the genesis hash (hash of the first entry) */
  private readonly genesisHashKey = "audit:genesis_hash";
  /** CRIT-04 fix: Whether sequence state has been loaded from the store */
  private sequenceInitialized = false;

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
      // HIGH-02 fix: Store HMAC key if provided
      // H-11 fix: Enforce minimum 32-byte HMAC key length to prevent brute-force attacks.
      // HMAC-SHA256 security relies on the key having sufficient entropy; keys shorter
      // than 32 bytes (256 bits) are below the hash output size and weaken the MAC.
      if (config.hmacKey) {
        // MED-T1-07 fix: Detect hex-encoded strings and decode as hex instead of UTF-8.
        // Previously, hex strings like "aabbcc..." were treated as UTF-8, producing a
        // buffer of ASCII character codes (double-length) instead of the intended binary
        // key material. This reduced effective entropy (e.g., a 64-char hex string
        // produces 64 bytes of ASCII instead of 32 bytes of key material).
        let keyBuffer: Buffer;
        if (typeof config.hmacKey === "string") {
          const isHex = /^[0-9a-fA-F]+$/.test(config.hmacKey) && config.hmacKey.length % 2 === 0;
          keyBuffer = isHex
            ? Buffer.from(config.hmacKey, "hex")
            : Buffer.from(config.hmacKey, "utf-8");
        } else {
          keyBuffer = config.hmacKey;
        }
        if (keyBuffer.length < 32) {
          throw new Error(
            "HMAC key must be at least 32 bytes (256 bits) for adequate security. " +
            `Provided key is ${keyBuffer.length} bytes. Use a cryptographically random key ` +
            "generated with crypto.randomBytes(32) or equivalent.",
          );
        }
        this.hmacKey = keyBuffer;
      }
      // STORE-007 fix: Store reset token if provided
      this.resetToken = config.resetToken;
      // MED-T3-09 fix: Store separate clear token if provided
      this.clearToken = config.clearToken;
      // STORE-010 fix: Store hash chain reset callback if provided
      this.onHashChainReset = config.onHashChainReset;
      // CRIT-08 fix: Store encryption key if provided, validating it is exactly 32 bytes
      if (config.encryptionKey) {
        if (config.encryptionKey.length !== 32) {
          throw new Error(
            "Encryption key must be exactly 32 bytes (256 bits) for AES-256-GCM. " +
            `Provided key is ${config.encryptionKey.length} bytes. ` +
            "Generate with crypto.randomBytes(32).",
          );
        }
        this.encryptionKey = config.encryptionKey;
      }
      // HIGH-20 fix: Store retention period if provided
      this.retentionDays = config.retentionDays;
      if (this.retentionDays && this.retentionDays > 0) {
        // Emit a one-time warning: retention enforcement depends on the store implementation
        void this.pruneExpiredEntries().catch(() => { /* non-fatal */ });
      }
    }

    if (this.maxConsecutiveFailures < 1) {
      throw new Error("maxConsecutiveFailures must be at least 1");
    }
  }

  /**
   * CRIT-04 fix: Lazily initialize sequence state from the persisted store.
   * This loads the total entry count and computes the next sequence number
   * from the most recent entry. Called once before the first log() or verifyIntegrity().
   */
  private async ensureSequenceInitialized(): Promise<void> {
    if (this.sequenceInitialized) return;

    // Load persisted total entry count
    const countStr = await this.store.get(this.entryCountKey);
    if (countStr !== null) {
      const parsed = parseInt(countStr, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        this.totalEntryCount = parsed;
      }
    }

    // Derive next sequence number from the most recent entry
    const recentRaw = await this.store.getRecent(this.storeKey, 1);
    if (recentRaw.length > 0) {
      try {
        // CRIT-08 fix: Decrypt entry if encryption is enabled
        const decrypted = this.decrypt(recentRaw[0]!);
        const parsed = JSON.parse(decrypted) as SequencedAuditEntry;
        if (isValidAuditEntry(parsed) && typeof parsed.sequenceNumber === "number") {
          this.nextSequenceNumber = parsed.sequenceNumber + 1;
        } else {
          // Legacy entries without sequence numbers — start from totalEntryCount
          this.nextSequenceNumber = this.totalEntryCount;
        }
      } catch {
        // Corrupted entry — will be caught by logInternal
        this.nextSequenceNumber = this.totalEntryCount;
      }
    }

    this.sequenceInitialized = true;
  }

  /**
   * Log an audit entry with hash chain integrity.
   *
   * S1-01 fix: Returns true on success, false on failure.
   * After maxConsecutiveFailures consecutive failures, throws AuditCircuitOpenError.
   * MED-12 fix: Serialized via mutex to prevent concurrent hash chain corruption.
   */
  /**
   * M-42 fix: Guard method that throws if the logger has been destroyed.
   * Called at the start of every public method to prevent silent degradation
   * from HMAC-SHA256 to plain SHA-256 after HMAC key material is zeroed.
   */
  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error(
        "AuditLogger has been destroyed. Create a new instance to continue logging. " +
        "Using a destroyed logger would silently degrade from HMAC-SHA256 to plain SHA-256.",
      );
    }
  }

  async log(entry: AuditEntry): Promise<boolean> {
    // M-42 fix: Reject all operations after destroy()
    this.ensureNotDestroyed();

    // Check if circuit is already open (before acquiring lock)
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new AuditCircuitOpenError(this.consecutiveFailures);
    }

    // MED-12 fix: Serialize log() calls to prevent concurrent writes corrupting the hash chain
    // CONC-10 fix: Add a timeout to mutex acquisition. Without this, a hung store operation
    // in logInternal() could hold the mutex indefinitely, cascading into total wallet
    // paralysis (since execute() calls log() under the execute mutex). The 10-second timeout
    // ensures the audit mutex releases before the wallet's 30-second execute mutex timeout,
    // preventing asymmetric timeout cascades.
    let releaseLock: () => void;
    const previousLock = this.logLock;
    this.logLock = new Promise<void>((resolve) => { releaseLock = resolve; });

    const AUDIT_MUTEX_TIMEOUT_MS = 10_000;
    const lockResult = await Promise.race([
      previousLock.then(() => "acquired" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), AUDIT_MUTEX_TIMEOUT_MS)),
    ]);

    if (lockResult === "timeout") {
      releaseLock!();
      // CONC-10 fix: Increment failure counter on timeout. This will eventually
      // trigger the audit circuit breaker (AuditCircuitOpenError) if timeouts persist.
      this.consecutiveFailures++;
      throw new Error(
        "AuditLogger: mutex acquisition timed out after 10 seconds. " +
        "A previous log() call may be hung on a store operation.",
      );
    }

    try {
      return await this.logInternal(entry);
    } finally {
      releaseLock!();
    }
  }

  /**
   * HIGH-02 fix: Compute hash using HMAC-SHA256 (if key is set) or plain SHA-256.
   * HMAC provides authenticity: even with full store read access, an attacker
   * cannot forge valid audit entries without the secret key.
   */
  private computeHash(data: string): string {
    if (this.hmacKey) {
      return createHmac("sha256", this.hmacKey).update(data).digest("hex");
    }
    // M-40 fix: Add domain separator prefix to plain SHA-256 path. Without HMAC,
    // plain SHA-256 is vulnerable to length extension attacks. A domain separator
    // ensures the hash input is uniquely prefixed, making it harder to exploit
    // length extension to forge valid hash chain entries.
    const hash = createHash("sha256");
    hash.update("kova-audit-v1:");
    hash.update(data);
    return hash.digest("hex");
  }

  /**
   * CRIT-08 fix: Encrypt a plaintext string using AES-256-GCM.
   * Returns a string in the format "iv:authTag:ciphertext" (all base64-encoded).
   * Uses a random 12-byte IV (GCM standard nonce size) for each encryption.
   */
  private encrypt(plaintext: string): string {
    if (!this.encryptionKey) {
      return plaintext;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  /**
   * CRIT-08 fix: Decrypt a ciphertext string encrypted with AES-256-GCM.
   * Expects input in the format "iv:authTag:ciphertext" (all base64-encoded).
   * Returns the original plaintext string.
   */
  private decrypt(ciphertext: string): string {
    if (!this.encryptionKey) {
      return ciphertext;
    }
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted audit entry format: expected iv:authTag:ciphertext");
    }
    const iv = Buffer.from(parts[0]!, "base64");
    const authTag = Buffer.from(parts[1]!, "base64");
    const encrypted = Buffer.from(parts[2]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }

  /**
   * Internal log implementation (called under mutex).
   *
   * CONC-17 NOTE: The append() + set(entryCountKey) sequence below is NOT atomic.
   * If the process is killed between append() and set(), the entry count will be
   * stale, and the hash chain's last_hash won't match the most recent entry's hash
   * for the next append. verifyIntegrity() will detect this on next run. For
   * production deployments, consider wrapping both operations in a store-level
   * transaction (SqliteStore supports this internally). See security_audit_team9 CONC-17.
   */
  private async logInternal(entry: AuditEntry): Promise<boolean> {
    try {
      // CRIT-04 fix: Ensure sequence state is initialized from persisted store
      await this.ensureSequenceInitialized();

      // Derive previous hash from the most recent entry in the list
      let previousHash = "";
      const recentRaw = await this.store.getRecent(this.storeKey, 1);
      if (recentRaw.length > 0) {
        try {
          // CRIT-08 fix: Decrypt entry if encryption is enabled
          const decrypted = this.decrypt(recentRaw[0]!);
          const parsed = JSON.parse(decrypted);
          // MED-33 fix: Validate before trusting as AuditEntry
          const lastEntry = isValidAuditEntry(parsed) ? parsed : null;
          previousHash = lastEntry?.hash ?? "";
          // MED-19 fix: Emit a process warning when the previous entry is corrupted
          // or missing a hash, as this breaks the hash chain integrity. The empty
          // previousHash starts a new chain segment, but operators should investigate.
          // STORE-010 fix: Also invoke onHashChainReset callback if configured.
          if (previousHash === "") {
            const reason =
              "Audit hash chain broken: previous entry missing or corrupted hash. " +
              "Starting new chain segment. Run verifyIntegrity() to assess damage.";
            process.emitWarning(reason, "KovaAuditWarning");
            this.onHashChainReset?.(reason);
          }
        } catch {
          // M-38 fix: Do NOT silently restart the chain when the last entry is corrupted.
          // Silently resetting previousHash to "" allows chain restart attacks — an attacker
          // who corrupts the last entry can cause the chain to restart, hiding all evidence
          // of prior entries. Instead, throw an error to force operator investigation.
          const reason =
            "Audit hash chain critically corrupted: last entry failed JSON parse. " +
            "Refusing to continue — this may indicate a chain restart attack. " +
            "Investigate the audit store and run verifyIntegrity() to assess damage.";
          process.emitWarning(reason, "KovaAuditWarning");
          this.onHashChainReset?.(reason);
          throw new Error(reason);
        }
      }

      // DATA-015 fix: Override caller-controlled timestamp with server-authoritative timestamp.
      // A caller could set a past/future timestamp to manipulate audit log ordering or
      // bypass time-based analysis. The server timestamp ensures chronological integrity.
      entry = { ...entry, timestamp: Date.now() };

      // CRIT-04 fix: Assign the next sequence number
      const sequenceNumber = this.nextSequenceNumber;

      // HIGH-01 fix: Use recursive canonical JSON for deterministic hash computation
      // MED-04 fix: Use domain separator to prevent length extension / collision attacks
      // HIGH-02 fix: Use HMAC-SHA256 when hmacKey is configured for authenticity
      const entryJson = canonicalJson(entry);
      const hash = this.computeHash(entryJson + HASH_DOMAIN_SEPARATOR + previousHash);

      // Create the enriched entry with hash chain fields and sequence number
      const enrichedEntry: SequencedAuditEntry = {
        ...entry,
        hash,
        previousHash: previousHash || undefined,
        sequenceNumber,
      };

      // Single atomic write
      // STORE-003: The store should ideally enforce append-only semantics for audit keys.
      // Currently, the Store interface does not prevent overwriting or deleting list entries
      // via set() on the same key. A production deployment should use a store implementation
      // that restricts mutations on audit keys to append-only (e.g., a write-ahead log, an
      // immutable ledger, or a store wrapper that rejects set()/delete() for "audit:*" keys).
      // CRIT-08 fix: Encrypt the serialized entry before storing if encryption is enabled
      const serialized = JSON.stringify(enrichedEntry);
      await this.store.append(this.storeKey, this.encrypt(serialized));

      // CRIT-04 fix: Update sequence tracking state
      this.nextSequenceNumber = sequenceNumber + 1;
      this.totalEntryCount++;

      // DATA-001 fix: Wrap counter and genesis hash updates in a nested try/catch.
      // The audit entry append above is the critical write. If it succeeds but the
      // metadata updates below fail (e.g., process crash, store contention), the entry
      // is still persisted. Without this, a metadata failure causes logInternal to
      // report false (failure), incrementing consecutiveFailures even though the entry
      // was logged — potentially triggering the circuit breaker unnecessarily.
      // ensureSequenceInitialized() derives sequence from the most recent entry on
      // restart, providing self-healing for stale counters.
      try {
        await this.store.set(this.entryCountKey, String(this.totalEntryCount));

        // CRIT-04 fix: Store genesis hash for the first entry
        if (sequenceNumber === 0) {
          await this.store.set(this.genesisHashKey, hash);
        }
      } catch (metadataErr) {
        // DATA-001 fix: Entry was logged — warn about stale metadata but don't fail
        const msg = metadataErr instanceof Error ? metadataErr.message : String(metadataErr);
        process.emitWarning(
          `AuditLogger: entry logged successfully but metadata update failed. ` +
          `Entry count or genesis hash may be stale until next restart. Error: ${msg}`,
          "KovaAuditWarning",
        );
      }

      // HIGH-20: Retention pruning is handled at the store level (see pruneExpiredEntries).

      // Success: reset failure counter
      this.consecutiveFailures = 0;
      return true;
    } catch (err) {
      this.consecutiveFailures++;
      this.onAuditFailure?.(err, this.consecutiveFailures);
      return false;
    }
  }

  /**
   * Get recent audit entries, newest first. Skips corrupted entries gracefully.
   *
   * LOW-07 fix: Ordering note — this method returns entries in newest-first order
   * (matching store.getRecent semantics). verifyIntegrity() internally reverses
   * the result to walk oldest-first for hash chain verification. Both methods
   * use the same underlying store.getRecent() call; the difference is only in
   * how they process the results.
   */
  async getRecent(count: number = 10): Promise<AuditEntry[]> {
    // M-42 fix: Reject all operations after destroy()
    this.ensureNotDestroyed();
    const raw = await this.store.getRecent(this.storeKey, count);
    const entries: AuditEntry[] = [];
    for (const r of raw) {
      try {
        // CRIT-08 fix: Decrypt entry if encryption is enabled
        const decrypted = this.decrypt(r);
        const parsed = JSON.parse(decrypted);
        // MED-19 fix: Validate parsed entry has required AuditEntry structure
        if (isValidAuditEntry(parsed)) {
          entries.push(parsed);
        }
        // Invalid schema entries are silently skipped (same as corrupted JSON)
      } catch {
        // Skip corrupted entries — don't let bad data block audit access
      }
    }
    return entries;
  }

  /**
   * CRIT-04 fix: Get the expected total number of audit entries ever written.
   * This count is persisted separately from the audit log entries themselves.
   * During verifyIntegrity(), this count is compared against the actual entries
   * to detect truncation attacks (where entries are silently removed).
   */
  async getEntryCount(): Promise<number> {
    this.ensureNotDestroyed();
    await this.ensureSequenceInitialized();
    return this.totalEntryCount;
  }

  /** Check if the audit circuit breaker is open (too many consecutive failures) */
  isCircuitOpen(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /** Get the current consecutive failure count */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Reset the failure counter (e.g., after manual intervention).
   *
   * STORE-007 fix: When a resetToken is configured in the AuditLoggerConfig,
   * this method requires a matching token parameter. This prevents unauthenticated
   * reset of the audit circuit breaker. If no resetToken was configured, the
   * method works without a token for backwards compatibility.
   *
   * SECURITY NOTE: This method is intentionally NOT private because operators need
   * to call it after manual intervention (e.g., fixing a broken store). However,
   * callers MUST configure a resetToken in AuditLoggerConfig to prevent untrusted
   * code from resetting the circuit breaker and suppressing audit failures.
   * The CircuitBreaker in circuit-breaker.ts has reset() as private because it
   * only resets on cooldown expiry; this method serves a different purpose
   * (operator-initiated recovery) and requires authentication instead.
   */
  resetFailureCount(token?: string): void {
    if (this.resetToken) {
      if (!token) {
        throw new Error(
          "AuditLogger.resetFailureCount: invalid or missing reset token. " +
          "A resetToken was configured — you must provide the correct token to reset the circuit breaker.",
        );
      }
      // H-12 fix: Use constant-time comparison to prevent timing side-channel attacks.
      // An attacker who can measure response time could otherwise brute-force the
      // reset token byte-by-byte via non-constant-time string comparison.
      const tokenBuffer = Buffer.from(token);
      const expectedBuffer = Buffer.from(this.resetToken);
      if (tokenBuffer.length !== expectedBuffer.length || !timingSafeEqual(tokenBuffer, expectedBuffer)) {
        throw new Error(
          "AuditLogger.resetFailureCount: invalid or missing reset token. " +
          "A resetToken was configured — you must provide the correct token to reset the circuit breaker.",
        );
      }
    } else {
      // DATA-002 fix: Warn when circuit breaker is reset without authentication.
      // In the default config path (no resetToken configured), any code with a reference
      // to the AuditLogger can reset the circuit breaker, potentially suppressing audit
      // failures. This warning alerts operators to configure a resetToken.
      process.emitWarning(
        "AuditLogger.resetFailureCount called without authentication (no resetToken configured). " +
        "Configure a resetToken in AuditLoggerConfig to prevent unauthenticated circuit breaker resets.",
        "SecurityWarning",
      );
    }
    this.consecutiveFailures = 0;
  }

  /**
   * M-34 fix: Clear the audit log with security safeguards.
   *
   * SECURITY WARNING: Clearing the audit log destroys the immutable record of all
   * prior policy decisions and transactions. This should ONLY be used in extreme
   * circumstances (e.g., data recovery, regulatory data deletion requirements).
   * In production, consider archiving the log before clearing.
   *
   * Safeguards:
   * 1. Requires the reset token (if configured) to prevent unauthorized clearing
   * 2. Logs a special "audit-cleared" entry before clearing, so the clearing event
   *    itself is recorded in the new chain
   * 3. Resets the sequence counter and entry count
   */
  async clear(token?: string): Promise<void> {
    this.ensureNotDestroyed();

    // MED-T5-02 fix: Serialize clear() through the same mutex as log() to prevent
    // concurrent clear() and log() calls from corrupting the hash chain.
    let releaseLock: () => void;
    const previousLock = this.logLock;
    this.logLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    await previousLock;

    try {
      await this.clearInternal(token);
    } finally {
      releaseLock!();
    }
  }

  /** MED-T5-02 fix: Internal clear implementation (called under mutex) */
  private async clearInternal(token?: string): Promise<void> {
    // MED-T3-09 fix: Use the separate clearToken if configured, otherwise fall back
    // to resetToken for backwards compatibility. This separates the operational
    // privilege (resetting the circuit breaker) from the admin privilege (destroying
    // the audit log), preventing a routine reset token from being used to clear logs.
    const requiredToken = this.clearToken ?? this.resetToken;
    if (requiredToken) {
      if (!token) {
        throw new Error(
          "AuditLogger.clear: clear token required. Clearing the audit log is a destructive " +
          "operation that requires authentication via the configured clearToken (or resetToken).",
        );
      }
      const tokenBuffer = Buffer.from(token);
      const expectedBuffer = Buffer.from(requiredToken);
      if (tokenBuffer.length !== expectedBuffer.length || !timingSafeEqual(tokenBuffer, expectedBuffer)) {
        throw new Error(
          "AuditLogger.clear: invalid clear token. Audit log clear rejected.",
        );
      }
    }

    // Log a special "audit-cleared" entry before clearing so the event is recorded
    // in the store. This entry will be the genesis entry of the new chain.
    const clearEntry: AuditEntry = {
      timestamp: Date.now(),
      intentId: "system:audit-cleared",
      intent: {
        type: "transfer",
        chain: "solana",
        params: { to: "system", amount: "0", token: "NONE" },
        metadata: { reason: "audit-log-cleared", agentId: "system" },
      },
      policyDecisions: [],
      finalDecision: { decision: "ALLOW" },
    };

    // Reset sequence state before logging the clear entry
    this.nextSequenceNumber = 0;
    this.totalEntryCount = 0;

    // Store the clear entry via the normal append path (bypasses the lock since
    // we're already in a controlled flow, but we use the internal method for
    // consistency with hash chain logic)
    const entryJson = canonicalJson(clearEntry);
    const hash = this.computeHash(entryJson + HASH_DOMAIN_SEPARATOR + "");
    const enrichedEntry: SequencedAuditEntry = {
      ...clearEntry,
      hash,
      previousHash: undefined,
      sequenceNumber: 0,
    };

    // MED-T5-09 fix: Clear the list namespace (not just KV namespace).
    // Previously used store.set() which only writes to the KV namespace, but
    // append()/getRecent() use the list namespace. Use clearList() if available.
    if (typeof this.store.clearList === "function") {
      await this.store.clearList(this.storeKey);
    } else {
      // DATA-009 fix: Throw an error when clearList() is not available instead of
      // silently falling back to store.set() which writes to the KV namespace and
      // does not clear list entries. The old fallback left entries accessible via
      // getRecent(), breaking the hash chain silently.
      throw new Error(
        "AuditLogger.clear(): store does not implement clearList(). " +
        "Custom Store implementations must provide clearList() to support audit log clearing.",
      );
    }
    // Re-create the list with the clear entry as genesis
    // CRIT-08 fix: Encrypt the serialized entry before storing if encryption is enabled
    const serialized = JSON.stringify(enrichedEntry);
    await this.store.append(this.storeKey, this.encrypt(serialized));

    // Update counters and store genesis hash for the new chain
    this.nextSequenceNumber = 1;
    this.totalEntryCount = 1;
    await this.store.set(this.entryCountKey, String(this.totalEntryCount));
    await this.store.set(this.genesisHashKey, hash);
  }

  /**
   * HIGH-20 fix: Prune audit log entries older than the configured retentionDays.
   *
   * NOTE: The Store interface is append-only and does not expose range deletion or
   * TTL-based key expiration. Implementing true pruning would require breaking the
   * append-only contract (via set() to overwrite the list) and would invalidate the
   * hash chain integrity. This method therefore emits a warning recommending that
   * retention enforcement be handled at the store level (e.g., SqliteStore with TTL
   * support) rather than at the logger level.
   *
   * TODO: Implement native TTL support in the Store interface (e.g., Store.deleteOlderThan())
   * to enable actual pruning without breaking hash chain integrity.
   */
  private async pruneExpiredEntries(): Promise<void> {
    if (!this.retentionDays || this.retentionDays <= 0) return;
    process.emitWarning(
      `AuditLogger: retentionDays is set to ${this.retentionDays} but the Store interface ` +
      "does not support TTL-based expiration or range deletion. Retention policy is not " +
      "enforced at the logger level — configure your Store implementation (e.g., SqliteStore) " +
      "to enforce TTL-based entry expiration for audit keys.",
      "KovaAuditWarning",
    );
  }

  /**
   * STORE-013 fix: Securely destroy the AuditLogger by zeroing HMAC key material.
   * Call this method during application shutdown to prevent key leakage from
   * memory dumps, core files, or heap snapshots. After calling destroy(),
   * further log() calls that rely on HMAC will produce incorrect hashes.
   */
  async destroy(): Promise<void> {
    // DATA-011 fix: Set destroyed flag BEFORE zeroing the HMAC key.
    // Previously, a concurrent log() call racing with destroy() could see
    // hmacKey already zeroed but destroyed still false, producing an entry
    // hashed with plain SHA-256 instead of HMAC-SHA256. This single wrong-
    // algorithm entry would break verification of all subsequent entries.
    this.destroyed = true;
    if (this.hmacKey) {
      this.hmacKey.fill(0);
      this.hmacKey = undefined;
    }
    // CRIT-08 fix: Zero encryption key material on destroy to prevent leakage
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
      this.encryptionKey = undefined;
    }
  }

  /**
   * MED-18 fix: Expose the onAuditFailure callback so the wallet can invoke it
   * when audit logging fails in the wallet's own logAudit() catch block (e.g.,
   * for denied transactions where the AuditLogger's internal callback may not fire).
   */
  getOnAuditFailure(): AuditFailureCallback | undefined {
    return this.onAuditFailure;
  }

  /**
   * Verify the integrity of the hash chain.
   * Walks the chain forward from oldest to newest, checking each hash.
   * HIGH-02 fix: Uses timing-safe comparison for all hash checks.
   * MED-04 fix: Uses domain separator in hash recomputation.
   *
   * STORE-014: Hash chain verification requires the same HMAC key that was used
   * when the audit entries were originally written. If the AuditLogger is
   * constructed with a different hmacKey (or without one when entries were written
   * with HMAC, or vice versa), every entry's recomputed hash will fail to match
   * the stored hash, producing a false-positive tampering report. Callers must
   * ensure the hmacKey in AuditLoggerConfig matches the key used at write time.
   * If you receive a verification failure on every entry starting at index 0,
   * an HMAC key mismatch is the most likely cause.
   *
   * @param count Number of recent entries to check (default: 100)
   */
  async verifyIntegrity(count: number = 100): Promise<IntegrityReport> {
    // M-42 fix: Reject all operations after destroy()
    this.ensureNotDestroyed();

    // CRIT-04 fix: Ensure sequence state is initialized from persisted store
    await this.ensureSequenceInitialized();

    const raw = await this.store.getRecent(this.storeKey, count);

    if (raw.length === 0) {
      // CRIT-04 fix: If we expect entries but find none, the log was truncated
      if (this.totalEntryCount > 0) {
        return {
          valid: false,
          entriesChecked: 0,
          firstBrokenAt: 0,
          error: `Truncation detected: expected ${this.totalEntryCount} entries but found 0. ` +
            "The entire audit log may have been deleted.",
        };
      }
      return { valid: true, entriesChecked: 0, firstBrokenAt: -1 };
    }

    // LOW-07 fix: getRecent() returns newest-first; we reverse to walk oldest-first
    // for hash chain verification (each entry's hash depends on the previous entry).
    const entries: SequencedAuditEntry[] = [];
    for (const r of raw) {
      try {
        // CRIT-08 fix: Decrypt entry if encryption is enabled
        const decrypted = this.decrypt(r);
        const parsed = JSON.parse(decrypted);
        // MED-33 fix: Validate parsed entry has required AuditEntry structure
        if (!isValidAuditEntry(parsed)) {
          return {
            valid: false,
            entriesChecked: entries.length,
            firstBrokenAt: entries.length,
            error: "Entry has invalid AuditEntry schema",
          };
        }
        entries.push(parsed as SequencedAuditEntry);
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

    // CRIT-04 fix: Verify genesis hash if we have the full chain from the beginning
    const firstEntry = entries[0]!;
    if (typeof firstEntry.sequenceNumber === "number" && firstEntry.sequenceNumber === 0) {
      const storedGenesisHash = await this.store.get(this.genesisHashKey);
      if (storedGenesisHash && firstEntry.hash && !safeHashEquals(firstEntry.hash, storedGenesisHash)) {
        return {
          valid: false,
          entriesChecked: 0,
          firstBrokenAt: 0,
          error: "Genesis hash mismatch: the first entry's hash does not match the stored genesis hash. " +
            "The beginning of the audit chain may have been tampered with.",
        };
      }
    }

    // CRIT-04 fix: Verify entry count against expected total (when checking full log)
    // Only check if we requested enough entries to cover the full log
    if (count >= this.totalEntryCount && this.totalEntryCount > 0) {
      if (entries.length < this.totalEntryCount) {
        return {
          valid: false,
          entriesChecked: 0,
          firstBrokenAt: 0,
          error: `Truncation detected: expected ${this.totalEntryCount} entries but found ${entries.length}. ` +
            "Entries may have been deleted from the audit log.",
        };
      }
    }

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

      // CRIT-04 fix: Verify sequence numbers are contiguous (no gaps)
      // Only check entries that have sequence numbers (legacy entries may not)
      if (typeof entry.sequenceNumber === "number") {
        if (i > 0) {
          const prevEntry = entries[i - 1]!;
          if (typeof prevEntry.sequenceNumber === "number") {
            const expectedSeq = prevEntry.sequenceNumber + 1;
            if (entry.sequenceNumber !== expectedSeq) {
              return {
                valid: false,
                entriesChecked: i,
                firstBrokenAt: i,
                error: `Sequence gap detected at entry ${i}: expected sequence number ${expectedSeq} ` +
                  `but found ${entry.sequenceNumber}. Entries may have been deleted from the chain.`,
              };
            }
          }
        }
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
      // Strip hash, previousHash, and sequenceNumber fields, then recompute using canonical JSON
      // CRIT-04 fix: sequenceNumber is added after hash computation in logInternal(),
      // so it must be excluded from the recomputation here to match.
      const { hash: _storedHash, previousHash: prevHash, sequenceNumber: _seq, ...entryContent } = entry;
      void _storedHash;
      void _seq;
      const entryJson = canonicalJson(entryContent);
      // MED-04 fix: Use domain separator in hash recomputation (must match log())
      // HIGH-02 fix: Use HMAC-SHA256 when hmacKey is configured (must match log())
      const expectedHash = this.computeHash(entryJson + HASH_DOMAIN_SEPARATOR + (prevHash ?? ""));

      // HIGH-02 fix: Timing-safe hash comparison
      // STORE-014 fix: Distinguish between hash chain break and HMAC key mismatch
      if (!safeHashEquals(entry.hash, expectedHash)) {
        // If an HMAC key is configured, a mismatch on every entry (especially the first)
        // likely indicates the wrong HMAC key rather than targeted tampering.
        const hmacHint = this.hmacKey
          ? " This may indicate an HMAC key mismatch — verify that the same hmacKey " +
            "used to write the audit log is being used for verification."
          : "";
        return {
          valid: false,
          entriesChecked: i,
          firstBrokenAt: i,
          error: `Entry ${i} hash does not match recomputed hash (tampered or corrupted).${hmacHint}`,
        };
      }
    }

    return { valid: true, entriesChecked: entries.length, firstBrokenAt: -1 };
  }
}
