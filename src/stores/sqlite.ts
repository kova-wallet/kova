/**
 * SqliteStore — Persistent store using better-sqlite3.
 *
 * Uses two tables:
 * - `kv` for key-value pairs with optional TTL expiration
 * - `lists` for append/getRecent operations (transaction logs)
 *
 * TTL expiration is lazy (checked on read), matching MemoryStore behavior.
 *
 * CONC-19 cross-reference: See security_audit_team9 CONC-19 for event loop blocking analysis.
 * STORE-015: CONCURRENT ACCESS — better-sqlite3 is a synchronous, in-process SQLite
 * binding. It does NOT support concurrent access from multiple processes. If multiple
 * Node.js processes share the same database file, WAL mode provides basic read
 * concurrency but writes will contend on the SQLite lock, potentially causing
 * SQLITE_BUSY errors. For multi-process deployments, use a shared Redis or
 * PostgreSQL-backed store instead.
 *
 * STORE-020: VACUUM/COMPACTION — SQLite does not automatically reclaim disk space
 * after deleting rows. Over time, frequent TTL expirations and list evictions leave
 * free pages in the database file. Run `VACUUM` periodically (e.g., via a cron job
 * calling `db.exec("VACUUM")`) to reclaim disk space in long-running deployments.
 */

import Database from "better-sqlite3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./interface.js";

/** CRIT-03 fix: Maximum entries per list key to prevent unbounded disk growth */
const MAX_LIST_SIZE = 100_000;

/** MED-21 fix: Maximum key length to prevent memory exhaustion and SQLite index issues */
const MAX_KEY_LENGTH = 512;

/** STORE-008 fix: Maximum value length to prevent unbounded disk growth, matching MemoryStore */
const MAX_VALUE_LENGTH = 1_000_000;

/**
 * MED-20 fix: Denied PRAGMAs that disable safety features.
 * These could lead to data corruption or durability loss.
 * L-24 fix: Extended to include additional dangerous PRAGMAs that could
 * compromise data integrity, durability, or security.
 */
const DENIED_PRAGMA_PATTERNS = [
  /journal_mode\s*=\s*(off|delete)/i,
  /synchronous\s*=\s*(off|0)/i,
  /writable_schema/i,
  /locking_mode\s*=\s*exclusive/i,
  /** STORE-018 fix: Prevent disabling secure_delete, which leaves deleted data recoverable on disk */
  /secure_delete\s*=\s*(off|0|false)/i,
  /** STORE-018 fix: Prevent temp_store=file, which writes temporary data to unencrypted disk files */
  /temp_store\s*=\s*file/i,
  /** L-24 fix: Prevent disabling foreign key constraints, which can leave orphaned rows */
  /foreign_keys\s*=\s*(off|0|false)/i,
  /** L-24 fix: Prevent enabling trusted_schema, which allows untrusted SQL in schema definitions */
  /trusted_schema\s*=\s*(on|1|true)/i,
];

/**
 * STORE-002 fix: Apply restrictive filesystem permissions (0o600) to SQLite WAL and SHM
 * auxiliary files. These files contain database content and must be protected from other
 * users on the system. Files may not exist yet (created lazily by SQLite), so errors are
 * silently ignored.
 */
function secureAuxFiles(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.chmodSync(dbPath + suffix, 0o600);
    } catch (err: unknown) {
      // T6-F13 fix: Log a warning when chmod fails on non-Windows systems instead
      // of silently ignoring. WAL/SHM files contain database content and should have
      // the same restrictive permissions as the main database file.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && typeof process !== "undefined" && process.platform !== "win32") {
        process.emitWarning(
          `SqliteStore: Failed to set permissions on ${dbPath}${suffix} (${code ?? "unknown error"}). ` +
          "This file may be readable by other users on the system.",
          "SecurityWarning",
        );
      }
    }
  }
}

/**
 * LOW-27 fix: Redact store keys in warning messages to prevent leaking sensitive
 * information like token identifiers, agent IDs, or wallet addresses.
 * Keys longer than 16 characters are truncated to first 8 + "..." + last 4 chars.
 */
function redactStoreKey(key: string): string {
  if (key.length > 16) {
    return key.slice(0, 8) + "..." + key.slice(-4);
  }
  return key;
}

/** MED-21 fix: Validate store key length and content */
function validateKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Store key exceeds max length of ${MAX_KEY_LENGTH}: ${key.length} chars`);
  }
  if (key.includes("\0")) {
    throw new Error("Store key must not contain null bytes");
  }
}

export interface SqliteStoreConfig {
  /** Path to the SQLite database file. Use ":memory:" for in-memory testing. */
  path: string;
  /**
   * MED-T5-06 fix: Additional allowed parent directories for the database file.
   * By default, SqliteStore only allows database paths within the current working
   * directory. Production deployments that need to use standard data directories
   * (e.g., `/var/lib/kova/`, `~/.kova/`) can add those directories here.
   * Each path is resolved to its real path before comparison.
   */
  allowedDirectories?: string[];
  /**
   * MED-02 fix: Optional PRAGMA statements executed after opening the database.
   * Use this to configure SQLCipher encryption if using a SQLCipher-compatible driver
   * (e.g., @journeyapps/sqlcipher or better-sqlite3 built with SQLCipher).
   *
   * Example for SQLCipher encryption:
   *   pragmas: ["key = 'your-secret-key'", "cipher_page_size = 4096"]
   *
   * WARNING: Without encryption, all audit logs, spending counters, idempotency cache
   * (including full TransactionResult objects), and circuit breaker state are stored
   * in plaintext. For production deployments handling real funds, use SQLCipher or
   * an encrypted filesystem.
   */
  pragmas?: string[];
  /**
   * AUDIT-CRIT-04 / STORE-001 fix: When true, the constructor throws if no encryption pragma
   * (containing "key") is found in the pragmas array. This prevents accidental
   * plaintext storage in production. Defaults to true as a security-first default —
   * callers must explicitly opt out with `requireEncryption: false` for development/testing.
   */
  requireEncryption?: boolean;
  /**
   * CRIT-T5-02 fix: HMAC key for counter integrity protection.
   * When provided, this key is used instead of auto-generating a random key.
   * This ensures counter HMACs survive process restarts — without a persistent
   * key, all counter HMACs become invalid after restart and counters reset to
   * zero, allowing an attacker who can force a restart to bypass spending/rate
   * limits. Must be a hex-encoded string of at least 64 characters (32 bytes).
   * Store this key in a secret manager or environment variable — NOT in the
   * database itself.
   */
  hmacKey?: string;
  /**
   * CRIT-09 fix: Optional AES-256-GCM encryption key for application-level encryption
   * of values stored in the database. When provided, all values written to the kv and
   * lists tables are encrypted before storage and decrypted on retrieval.
   *
   * Must be exactly 32 bytes (256 bits) for AES-256-GCM. Generate one with:
   *   crypto.randomBytes(32)
   *
   * Encrypted values are stored in the format: iv:authTag:ciphertext (all base64-encoded).
   * A fresh random 12-byte IV is generated for each encryption operation.
   *
   * WARNING: Enabling encryption on an existing plaintext database will cause all
   * previously stored values to fail decryption. Migrate data before enabling.
   * Store this key in a secret manager or environment variable — NOT in the
   * database itself.
   */
  encryptionKey?: Buffer;
}

/** H-19 fix: Maximum retries for SQLITE_BUSY errors with exponential backoff */
const MAX_RETRIES = 3;

export class SqliteStore implements Store {
  private readonly db: Database.Database;
  /** STORE-002 fix: Store db path for periodic auxiliary file permission checks */
  private readonly dbPath: string;
  /** M-20 fix: Track whether aux files have been secured to avoid chmod on every write */
  private auxFilesSecured = false;
  /**
   * H-25 fix: Per-instance HMAC key for integrity protection of counter values.
   * This is defense-in-depth against store manipulation: an attacker who can
   * directly modify database rows (e.g., via SQL injection in another component
   * or direct file access) cannot forge valid counter values without this key.
   */
  // T1-F5 fix: Mutable Buffer (not readonly string) so destroy() can zero the key material
  // in-place via Buffer.fill(0). Strings are immutable in V8 and cannot be reliably zeroed.
  private hmacKey: Buffer;
  /**
   * CRIT-09 fix: Optional AES-256-GCM encryption key for application-level encryption.
   * When set, all values are encrypted before writing and decrypted after reading.
   * Stored as a mutable Buffer so destroy() can zero the key material in-place.
   */
  private encryptionKey: Buffer | null = null;

  /**
   * Create a new SqliteStore. Opens (or creates) the database at the given path.
   *
   * MED-02 fix: Custom pragmas are executed BEFORE standard pragmas and schema init,
   * allowing SQLCipher key to be set before any table access.
   *
   * M-19 WARNING — EVENT LOOP BLOCKING:
   * better-sqlite3 operations are synchronous and will block the Node.js event loop
   * for the duration of each SQLite operation. For high-throughput scenarios with many
   * concurrent wallet operations, consider:
   *   1. Using worker_threads to offload SQLite operations to a separate thread
   *   2. Batching multiple operations into a single transaction to reduce overhead
   *   3. Using a maxBatchSize config to limit the number of operations per tick
   * In practice, individual key-value operations complete in microseconds, but bulk
   * operations (e.g., sweepExpired on large datasets) can block for milliseconds.
   */
  constructor(config: SqliteStoreConfig) {
    // HIGH-23 fix: Reject paths containing path traversal sequences.
    // Prevents an attacker who controls the config from writing the database
    // to an arbitrary location (e.g., "../../etc/cron.d/exploit").
    // LOW-12 fix: Additionally resolve the path and verify it doesn't escape the
    // current working directory. This catches symlink-based and encoded traversal
    // attempts that a simple ".." substring check would miss.
    // M-36 fix: Resolve the path BEFORE validation and use the resolved path for
    // all subsequent operations, ensuring path validation cannot be bypassed via
    // relative path tricks or symlinks.
    let resolvedDbPath = config.path;
    if (config.path !== ":memory:") {
      const normalized = config.path.replace(/\\/g, "/");
      if (normalized.includes("..")) {
        throw new Error(
          `SqliteStore: path must not contain path traversal sequences (\"..\"): ${config.path}`,
        );
      }
      // M-36 fix: Resolve path early and use resolvedDbPath for ALL subsequent operations
      resolvedDbPath = path.resolve(config.path);
      // STORE-011 fix: Resolve symlinks before path validation to close TOCTOU gap.
      // Without this, an attacker could create a symlink between validation and database
      // opening, causing the database to be written to an arbitrary location.
      try {
        // Resolve symlinks if the file or parent directory already exists
        resolvedDbPath = fs.realpathSync(resolvedDbPath);
      } catch {
        // File doesn't exist yet — resolve the parent directory instead
        const parentDir = path.dirname(resolvedDbPath);
        try {
          resolvedDbPath = path.join(fs.realpathSync(parentDir), path.basename(resolvedDbPath));
        } catch {
          // Parent doesn't exist either — fall back to the already-resolved path
        }
      }
      // MED-T5-06 fix: Allow database paths in CWD or any explicitly allowed directory.
      // Production deployments often need /var/lib/kova/, ~/.kova/, etc.
      const cwd = process.cwd();
      const allowedDirs = [cwd, ...(config.allowedDirectories ?? [])].map(dir => {
        try { return fs.realpathSync(path.resolve(dir)); } catch { return path.resolve(dir); }
      });
      const isAllowed = allowedDirs.some(dir =>
        resolvedDbPath.startsWith(dir + path.sep) || resolvedDbPath === dir
      );
      if (!isAllowed) {
        throw new Error(
          `SqliteStore: resolved path "${resolvedDbPath}" is not within any allowed directory. ` +
          `Allowed: [${allowedDirs.join(", ")}]. ` +
          `Add the target directory to allowedDirectories in SqliteStoreConfig.`,
        );
      }
    }

    // AUDIT-CRIT-04 fix: Enforce encryption requirement when configured
    // CRIT-05 fix: More robust encryption pragma detection. Instead of just checking
    // for substring "key" (which could match unrelated pragmas like "monkey_patch"),
    // we trim the pragma and check that it starts with "key" or "KEY" (the SQLCipher
    // encryption pragma). WARNING: This detection is still fragile — it relies on
    // the pragma string format and may not cover all SQLCipher configurations
    // (e.g., "hexkey", "rekey"). Callers should always explicitly set requireEncryption
    // to true in production rather than relying on auto-detection.
    const hasEncryptionPragma = config.pragmas?.some(
      (p) => {
        const trimmed = p.trimStart();
        return trimmed.startsWith("key") || trimmed.startsWith("KEY");
      },
    ) ?? false;

    // STORE-001 fix: Default requireEncryption to true (security-first default)
    const requireEncryption = config.requireEncryption ?? true;

    if (requireEncryption && !hasEncryptionPragma) {
      throw new Error(
        "SqliteStore: requireEncryption is true but no encryption pragma (containing 'key') was provided. " +
        "Configure SQLCipher encryption via pragmas or set requireEncryption to false for development.",
      );
    }

    // AUDIT-CRIT-04 fix: Warn when using on-disk storage without encryption
    if (config.path !== ":memory:" && !hasEncryptionPragma) {
      process.emitWarning(
        "SqliteStore is configured without encryption. Audit logs, spending counters, and " +
        "transaction data will be stored in plaintext. For production use, configure SQLCipher " +
        "encryption via the 'pragmas' option or use requireEncryption: true to enforce it.",
        "SecurityWarning",
      );
    }

    // M-32 fix: Use umask to ensure the database file is created with restrictive
    // permissions from the start, closing the TOCTOU race between file creation and
    // the subsequent chmod call. Without this, there is a brief window where the file
    // exists with default permissions (typically 0o644), allowing other users to read it.
    let oldUmask: number | undefined;
    if (resolvedDbPath !== ":memory:") {
      oldUmask = process.umask(0o077); // Only owner can access
    }
    try {
      // M-36 fix: Use resolvedDbPath for database creation
      this.db = new Database(resolvedDbPath);
    } finally {
      if (oldUmask !== undefined) {
        process.umask(oldUmask);
      }
    }
    // M-36 fix: Store the resolved path for all subsequent operations
    this.dbPath = resolvedDbPath;

    // DATA-014 fix: After opening the database, verify the real path matches what
    // we validated. An attacker could recreate a symlink between realpathSync()
    // and Database() open, redirecting the database to an attacker-controlled location.
    if (resolvedDbPath !== ":memory:") {
      try {
        const actualPath = fs.realpathSync(resolvedDbPath);
        if (actualPath !== resolvedDbPath) {
          this.db.close();
          throw new Error(
            `SqliteStore: symlink TOCTOU detected — path resolved to "${actualPath}" after open, ` +
            `but was expected to be "${resolvedDbPath}". The file may have been replaced with a symlink.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("symlink TOCTOU")) throw err;
        // If realpath fails (file was deleted?), close and throw
        this.db.close();
        throw new Error(
          `SqliteStore: post-open path validation failed for "${resolvedDbPath}". ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // MED-21 fix: Set restrictive file permissions (owner read/write only) on the
    // database file to prevent other users on the system from reading wallet data.
    // Skipped for in-memory databases which have no file on disk.
    if (this.dbPath !== ":memory:") {
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        // Best-effort — may fail on Windows or read-only filesystems
      }
    }

    // MED-02 fix: Apply custom pragmas first (e.g., SQLCipher key)
    // MED-20 fix: Reject PRAGMAs that disable safety features
    if (config.pragmas) {
      for (const pragma of config.pragmas) {
        const denied = DENIED_PRAGMA_PATTERNS.some((pattern) => pattern.test(pragma));
        if (denied) {
          throw new Error(
            `SqliteStore: PRAGMA "${pragma}" is denied because it disables safety features. ` +
            `journal_mode must be WAL/wal, synchronous must not be OFF/0, and writable_schema is not allowed.`,
          );
        }
        this.db.pragma(pragma);
      }
    }

    // H-26 fix: Verify that SQLCipher encryption is actually active after applying pragmas.
    // If the better-sqlite3 binary was not compiled with SQLCipher support, the PRAGMA key
    // statement silently no-ops, leaving the database unencrypted. This check ensures that
    // encryption is genuinely active before proceeding.
    if (hasEncryptionPragma) {
      try {
        const cipherCheck = this.db.pragma("cipher_version");
        if (!cipherCheck || (Array.isArray(cipherCheck) && cipherCheck.length === 0)) {
          this.db.close();
          throw new Error(
            "SqliteStore: SQLCipher encryption was requested via pragmas but cipher_version " +
            "returned empty. This means the better-sqlite3 binary was not compiled with SQLCipher " +
            "support. Install a SQLCipher-compatible driver (e.g., @journeyapps/sqlcipher) or " +
            "rebuild better-sqlite3 with SQLCipher.",
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("SQLCipher encryption was requested")) {
          throw err;
        }
        // If pragma itself throws, SQLCipher is not available
        this.db.close();
        throw new Error(
          "SqliteStore: SQLCipher encryption was requested but not available. " +
          "cipher_version PRAGMA failed. Ensure better-sqlite3 is compiled with SQLCipher support.",
        );
      }
    }

    // HIGH-T5-03 fix: Detect SQLCipher availability even when no encryption pragma is configured.
    // If SQLCipher is available but no key pragma was set, warn that encryption is available
    // but not configured. This helps operators discover they're running without encryption
    // on a SQLCipher-enabled binary.
    if (!hasEncryptionPragma) {
      try {
        const cipherCheck = this.db.pragma("cipher_version");
        if (cipherCheck && Array.isArray(cipherCheck) && cipherCheck.length > 0) {
          process.emitWarning(
            "SqliteStore: SQLCipher is available (cipher_version detected) but no encryption " +
            "pragma was configured. The database will be stored in plaintext. Configure a 'key' " +
            "pragma in SqliteStoreConfig.pragmas to enable encryption.",
            "SecurityWarning",
          );
        }
      } catch {
        // SQLCipher not available — no action needed
      }
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    // DATA-010 fix: Enable secure_delete so deleted data (counter values, HMAC keys,
    // audit entries) is overwritten with zeros instead of being left recoverable in
    // SQLite's free pages. Without this, sensitive data can be recovered forensically.
    this.db.pragma("secure_delete = ON");

    // STORE-002 fix: Secure WAL and SHM auxiliary files after enabling WAL mode
    // M-20 fix: Only secure once during initialization (not on every write)
    if (this.dbPath !== ":memory:") {
      secureAuxFiles(this.dbPath);
      this.auxFilesSecured = true;
    }

    // CRIT-T5-02 fix: Use provided HMAC key if available, otherwise auto-generate.
    // A persistent HMAC key ensures counter integrity survives process restarts.
    // Without this, all counters reset to zero on restart (HMAC mismatch → reset),
    // allowing an attacker who can force a restart to bypass spending/rate limits.
    if (config.hmacKey) {
      if (config.hmacKey.length < 64) {
        throw new Error(
          "SqliteStore: hmacKey must be at least 64 hex characters (32 bytes). " +
          "Generate one with: crypto.randomBytes(32).toString('hex')",
        );
      }
      // T1-F5 fix: Store as Buffer for reliable zeroization via Buffer.fill(0)
      this.hmacKey = Buffer.from(config.hmacKey, "hex");
    } else {
      // T1-F5 fix: Store raw bytes instead of hex string
      this.hmacKey = crypto.randomBytes(32);
      // DATA-003 fix: Upgrade from warning to hard error for persistent (non-memory) databases.
      // Ephemeral HMAC keys mean all counter HMACs become invalid on process restart,
      // resetting spending/rate limit counters to zero. An attacker who can force a
      // restart can bypass all spending limits. Only :memory: databases (testing) are
      // exempt since they lose all data on restart anyway.
      if (config.path !== ":memory:") {
        throw new Error(
          "SqliteStore: no hmacKey provided for persistent database at '" + config.path + "'. " +
          "Without a persistent hmacKey, all spending/rate limit counters will reset on process " +
          "restart, allowing bypass of spending limits. Generate a key with: " +
          "crypto.randomBytes(32).toString('hex') and pass it via SqliteStoreConfig.hmacKey. " +
          "For testing, use path: ':memory:' which does not require a persistent hmacKey.",
        );
      }
    }

    // CRIT-09 fix: Validate and store optional AES-256-GCM encryption key
    if (config.encryptionKey) {
      if (config.encryptionKey.length !== 32) {
        throw new Error(
          "SqliteStore: encryptionKey must be exactly 32 bytes (256 bits) for AES-256-GCM. " +
          `Got ${config.encryptionKey.length} bytes. Generate one with: crypto.randomBytes(32)`,
        );
      }
      // Copy the buffer so the caller cannot mutate it after construction
      this.encryptionKey = Buffer.from(config.encryptionKey);
    }

    // HIGH-T5-04 fix: Wrap initialization in try/catch to ensure the database
    // connection is closed if schema creation fails (e.g., disk full, corruption).
    // Without this, a failed constructor leaves an open file handle that cannot
    // be closed because the SqliteStore instance is never returned to the caller.
    try {
      this.initialize();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private initialize(): void {
    // M-37 fix: Wrap schema initialization in try/catch for corruption/disk-full errors
    try {
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

      // T6-F16 fix: Track schema version for future migrations.
      // Without version tracking, schema changes would require users to manually
      // delete and recreate databases, losing all audit history and counters.
      const CURRENT_SCHEMA_VERSION = "1";
      const existingVersion = this.db
        .prepare("SELECT value FROM kv WHERE key = ?")
        .get("__schema_version__") as { value: string } | undefined;
      if (!existingVersion) {
        this.db
          .prepare("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)")
          .run("__schema_version__", CURRENT_SCHEMA_VERSION);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("database disk image is malformed") || message.includes("corrupt")) {
        throw new Error(
          `SqliteStore: database appears to be corrupted. Recovery options: ` +
          `(1) Delete the database file and restart to create a fresh database. ` +
          `(2) Use 'sqlite3 <dbpath> ".recover" | sqlite3 <newpath>' to attempt recovery. ` +
          `Original error: ${message}`,
        );
      }
      if (message.includes("database or disk is full") || message.includes("SQLITE_FULL")) {
        throw new Error(
          `SqliteStore: database or disk is full. Free disk space or move the database ` +
          `to a volume with more available space. Original error: ${message}`,
        );
      }
      throw err;
    }
  }

  /**
   * M-20 fix: Secure auxiliary files only once (on first write) instead of on every
   * write operation. This prevents the event loop from blocking on chmod syscalls
   * for every single store write. The aux files are secured initially in the
   * constructor after WAL mode is enabled, and this method provides a fallback
   * for edge cases where they might be recreated.
   */
  private secureAuxFilesOnce(): void {
    if (this.auxFilesSecured) return;
    secureAuxFiles(this.dbPath);
    this.auxFilesSecured = true;
  }

  /**
   * CRIT-09 fix: Encrypt a plaintext string using AES-256-GCM.
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
   * CRIT-09 fix: Decrypt a ciphertext string produced by encrypt().
   * Expects format: iv:authTag:ciphertext (all base64-encoded).
   * If no encryptionKey is configured, returns the ciphertext unchanged.
   * Throws on authentication failure (tampered data) or malformed input.
   */
  private decrypt(ciphertext: string): string {
    if (!this.encryptionKey) return ciphertext;
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error(
        "SqliteStore: encrypted value has invalid format (expected iv:authTag:ciphertext). " +
        "The database may contain plaintext values from before encryption was enabled.",
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
   * H-25 fix: Compute HMAC for a counter value. This is defense-in-depth against
   * direct store manipulation — if an attacker modifies counter values in the
   * database file (e.g., via direct file access or SQL injection in another
   * component), the HMAC will not match and the tampered value will be rejected.
   * The HMAC key is generated per-instance, so it is only effective for the
   * lifetime of this SqliteStore instance.
   */
  private computeCounterHmac(key: string, value: string): string {
    // MED-01 fix: Use length-prefixed concatenation to prevent ambiguity.
    // Previously `key + ":" + value` was used, but if key contains a colon,
    // different key/value pairs can produce the same HMAC input (e.g.,
    // key="a:b" value="c" vs key="a" value="b:c"). Length-prefixing the key
    // makes the boundary unambiguous regardless of key content.
    return crypto
      .createHmac("sha256", this.hmacKey)
      .update(`${key.length.toString(16)}:${key}:${value}`)
      .digest("hex");
  }

  /**
   * H-25 fix: Verify HMAC integrity of a counter value.
   * Returns true if the HMAC is valid, false if tampered or missing.
   */
  private verifyCounterHmac(key: string, value: string, hmac: string): boolean {
    const expected = this.computeCounterHmac(key, value);
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
   * H-19 fix: Execute a write operation with retry logic for SQLITE_BUSY errors.
   * Uses exponential backoff (10ms, 20ms, 40ms) to handle WAL write contention
   * in multi-process scenarios where busy_timeout alone may not be sufficient.
   */
  private async executeWithRetry<T>(operation: () => T): Promise<T> {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return operation();
      } catch (err: unknown) {
        const errCode = (err as { code?: string })?.code;
        const errMsg = err instanceof Error ? err.message : String(err);
        if ((errCode === "SQLITE_BUSY" || errMsg.includes("SQLITE_BUSY")) && i < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 10 * Math.pow(2, i)));
          continue;
        }
        // M-37 fix: Provide clear error messages for corruption and disk-full conditions
        if (errMsg.includes("database disk image is malformed") || errMsg.includes("corrupt")) {
          throw new Error(
            `SqliteStore: database appears to be corrupted. Recovery options: ` +
            `(1) Delete the database file and restart to create a fresh database. ` +
            `(2) Use 'sqlite3 <dbpath> ".recover" | sqlite3 <newpath>' to attempt recovery. ` +
            `Original error: ${errMsg}`,
          );
        }
        if (errMsg.includes("database or disk is full") || errMsg.includes("SQLITE_FULL")) {
          throw new Error(
            `SqliteStore: database or disk is full. Free disk space or move the database ` +
            `to a volume with more available space. Original error: ${errMsg}`,
          );
        }
        throw err;
      }
    }
    // Should not be reached, but TypeScript needs it
    throw new Error("SqliteStore: executeWithRetry exhausted retries");
  }

  /**
   * Retrieve a value by key. Returns null if not found or expired.
   *
   * STORE-019 WARNING: Callers must validate data read from the store before use.
   * Values are stored as opaque strings and may have been written by a different
   * version of the SDK, corrupted on disk, or tampered with if encryption is not
   * enabled. Always parse and validate the returned string (e.g., JSON.parse with
   * schema validation) rather than trusting it blindly.
   *
   * ARCH-09 cross-reference: See security_audit_team10 ARCH-09 for full analysis.
   * M-35 WARNING: TTL enforcement relies on system clock integrity (Date.now()).
   * An attacker with clock manipulation access (e.g., NTP spoofing or direct
   * clock adjustment) can bypass TTL-based spending and rate limits by setting
   * the clock forward to expire counters prematurely. Consider using monotonic
   * clocks (performance.now()) for relative time calculations if running in a
   * threat model where clock manipulation is a concern.
   *
   * M-19 NOTE: This method uses synchronous better-sqlite3 operations that block
   * the event loop. For high-throughput scenarios, consider using worker_threads.
   */
  async get(key: string): Promise<string | null> {
    validateKey(key);
    // DATA-006 fix: Filter expired entries directly in the SELECT query instead of
    // lazy deletion after read. With WAL mode and multiple connections, a reader
    // could see a counter value that another connection has already expired.
    const now = Date.now();
    const row = this.db
      .prepare("SELECT value, expires_at FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(key, now) as { value: string; expires_at: number | null } | undefined;

    if (!row) {
      // Best-effort cleanup of potentially expired entry
      try {
        await this.executeWithRetry(() => {
          this.db.prepare("DELETE FROM kv WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(key, now);
        });
      } catch { /* non-fatal cleanup */ }
      return null;
    }

    // CRIT-09 fix: Decrypt value before returning if encryption is enabled
    return this.decrypt(row.value);
  }

  /**
   * Store a key-value pair with optional TTL in seconds.
   * M-19 NOTE: Uses synchronous better-sqlite3 operations that block the event loop.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    validateKey(key);
    // MED-08 fix: Validate ttlSeconds is a finite positive number to prevent
    // NaN or Infinity from causing incorrect TTL behavior (e.g., NaN * 1000 = NaN).
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`SqliteStore.set: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    // STORE-008 fix: Reject values exceeding maximum length to prevent unbounded disk growth
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(`Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`);
    }
    const expiresAt =
      ttlSeconds !== undefined && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null;

    // CRIT-09 fix: Encrypt value before storing if encryption is enabled
    const encryptedValue = this.encrypt(value);

    // H-19 fix: Retry on SQLITE_BUSY with exponential backoff
    await this.executeWithRetry(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
        )
        .run(key, encryptedValue, expiresAt);
    });

    // M-20 fix: Only secure auxiliary files once instead of on every write.
    // STORE-002 fix: Re-secure auxiliary files after write operations.
    if (this.dbPath !== ":memory:") {
      this.secureAuxFilesOnce();
    }
  }

  /**
   * MED-04 fix: Atomically set a value only if the key does not exist (or is expired).
   * Uses a SQLite transaction for atomicity.
   * Returns true if set, false if key already exists.
   * M-19 NOTE: Uses synchronous better-sqlite3 operations that block the event loop.
   */
  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    validateKey(key);
    // MED-08 fix: Validate ttlSeconds is a finite positive number to prevent
    // NaN or Infinity from causing incorrect TTL behavior.
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error(`SqliteStore.setIfNotExists: ttlSeconds must be a positive finite number, got ${ttlSeconds}`);
    }
    // STORE-008 fix: Reject values exceeding maximum length to prevent unbounded disk growth
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(`Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`);
    }
    const expiresAt =
      ttlSeconds !== undefined && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null;

    // CRIT-09 fix: Encrypt value before storing if encryption is enabled
    const encryptedValue = this.encrypt(value);

    // H-19 fix: Retry on SQLITE_BUSY with exponential backoff
    const result = await this.executeWithRetry(() => {
      return this.db.transaction(() => {
        const existing = this.db
          .prepare("SELECT expires_at FROM kv WHERE key = ?")
          .get(key) as { expires_at: number | null } | undefined;

        if (existing) {
          if (existing.expires_at !== null && Date.now() > existing.expires_at) {
            // Expired — delete and continue to insert
            this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
          } else {
            return false; // Key exists and not expired
          }
        }

        this.db
          .prepare("INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)")
          .run(key, encryptedValue, expiresAt);
        return true;
      })();
    });

    // M-20 fix: Only secure auxiliary files once instead of on every write.
    if (this.dbPath !== ":memory:") {
      this.secureAuxFilesOnce();
    }

    return result;
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
   * places to limit drift accumulation. SQLite uses native numeric types which
   * provide better precision than JavaScript floats for intermediate calculations.
   *
   * SpendingLimitRule mitigates this by using BigInt-based safeGt() for limit
   * comparisons, but the accumulated counter value itself is still approximate.
   * For applications requiring exact precision (e.g., sub-cent accounting),
   * counters should use string-based decimal arithmetic (e.g., Decimal.js)
   * or store amounts as integer minor units (lamports, satoshis, wei).
   * =========================================================================
   *
   * M-35 WARNING — TTL BYPASS VIA CLOCK MANIPULATION:
   * TTL enforcement relies on system clock integrity (Date.now()). See get()
   * documentation for detailed threat analysis.
   *
   * M-19 NOTE: Uses synchronous better-sqlite3 operations that block the event loop.
   * For high-throughput scenarios, consider using worker_threads.
   * =========================================================================
   */
  async increment(key: string, amount: number): Promise<number> {
    // STORE-012 fix: Reject non-finite amounts (NaN, Infinity) to prevent counter corruption
    if (!Number.isFinite(amount)) {
      throw new Error(`increment amount must be a finite number, got ${typeof amount === 'number' ? amount : typeof amount}`);
    }
    validateKey(key);
    // H-19 fix: Retry on SQLITE_BUSY with exponential backoff
    const result = await this.executeWithRetry(() => {
      return this.db.transaction(() => {
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
            // CRIT-09 fix: Decrypt the stored value before parsing if encryption is enabled
            const decryptedValue = this.decrypt(existing.value);
            // H-25 fix: Verify HMAC integrity of existing counter value before trusting it.
            // The HMAC is stored in a separate key ({key}:__hmac) to avoid polluting the
            // counter value returned by get().
            // CRIT-09 note: HMAC is computed on the plaintext value, not the encrypted form,
            // so we verify against the decrypted value.
            const hmacRow = this.db
              .prepare("SELECT value FROM kv WHERE key = ?")
              .get(key + ":__hmac") as { value: string } | undefined;
            // CRIT-09 fix: Decrypt HMAC value if encryption is enabled
            const hmacValue = hmacRow ? this.decrypt(hmacRow.value) : undefined;
            // DATA-005 fix: Warn when HMAC entry is missing. This could indicate:
            // (a) the counter was initialized via set() (legitimate, no HMAC created), or
            // (b) an attacker deleted the HMAC entry to bypass integrity checks.
            // We emit a SecurityWarning but trust the value, since set()-initialized
            // counters legitimately lack HMAC entries. Only when an HMAC EXISTS but is
            // INVALID do we reset to 0 (definitive evidence of tampering).
            if (!hmacValue) {
              try {
                // LOW-27 fix: Redact key to prevent leaking sensitive token/agent/wallet info in warnings
                process.emitWarning(
                  `SqliteStore.increment: HMAC entry missing for key "${redactStoreKey(key)}". ` +
                  `Counter may have been tampered with (HMAC deleted), or was initialized via set().`,
                  "SecurityWarning",
                );
              } catch { /* non-fatal */ }
              // Trust the value but proceed with caution — next increment will create an HMAC
              const parsed = parseFloat(decryptedValue);
              current = isNaN(parsed) ? 0 : parsed;
            } else if (!this.verifyCounterHmac(key, decryptedValue, hmacValue)) {
              try {
                // LOW-27 fix: Redact key to prevent leaking sensitive token/agent/wallet info in warnings
                process.emitWarning(
                  `SqliteStore.increment: HMAC verification failed for key "${redactStoreKey(key)}". ` +
                  `Counter value may have been tampered with. Resetting to 0.`,
                  "SecurityWarning",
                );
              } catch { /* non-fatal */ }
              current = 0;
            } else {
              const parsed = parseFloat(decryptedValue);
              // MED-23 fix: Detect non-numeric counter values instead of silently resetting
              if (isNaN(parsed)) {
                try {
                  // LOW-27 fix: Redact key to prevent leaking sensitive token/agent/wallet info in warnings
                  process.emitWarning(
                    `SqliteStore.increment: key "${redactStoreKey(key)}" contains non-numeric value. ` +
                    `Treating as 0. This may indicate data corruption or key collision.`,
                    "StoreWarning",
                  );
                } catch { /* non-fatal */ }
              }
              current = isNaN(parsed) ? 0 : parsed;
            }
            expiresAt = existing.expires_at;
          }
        }

        // L-04 fix: Clamp counter value to zero floor to prevent negative counters
        const rawNewValue = current + amount;
        // M-02 fix: Round to 12 decimal places to limit floating-point drift accumulation
        const newValue = Math.max(0, parseFloat(rawNewValue.toFixed(12)));

        // H-25 fix: Compute HMAC for integrity protection of the new counter value.
        // Stored in a separate key ({key}:__hmac) so get() returns the clean counter value.
        // CRIT-09 note: HMAC is computed on the plaintext value string, then the HMAC
        // itself is encrypted before storage (if encryption is enabled).
        const valueStr = String(newValue);
        const hmac = this.computeCounterHmac(key, valueStr);
        this.db
          .prepare(
            "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
          )
          .run(key + ":__hmac", this.encrypt(hmac), expiresAt);

        // CRIT-09 fix: Encrypt the counter value before storing
        this.db
          .prepare(
            "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
          )
          .run(key, this.encrypt(valueStr), expiresAt);

        return newValue;
      })();
    });

    // M-20 fix: Only secure auxiliary files once instead of on every write.
    if (this.dbPath !== ":memory:") {
      this.secureAuxFilesOnce();
    }

    return result;
  }

  /**
   * Append a value to a list. Used for audit logs and transaction history.
   * CRIT-03 fix: Evicts oldest entries when list exceeds MAX_LIST_SIZE.
   * M-19 NOTE: Uses synchronous better-sqlite3 operations that block the event loop.
   */
  async append(key: string, value: string): Promise<void> {
    validateKey(key);
    // CRIT-09 fix: Encrypt value before storing if encryption is enabled
    const encryptedValue = this.encrypt(value);
    // H-19 fix: Retry on SQLITE_BUSY with exponential backoff
    await this.executeWithRetry(() => {
      this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO lists (key, value, created_at) VALUES (?, ?, ?)",
          )
          .run(key, encryptedValue, Date.now());

        // CRIT-03 fix: Evict oldest entries when list exceeds max size
        const countRow = this.db
          .prepare("SELECT COUNT(*) as cnt FROM lists WHERE key = ?")
          .get(key) as { cnt: number };

        if (countRow.cnt > MAX_LIST_SIZE) {
          const excess = countRow.cnt - MAX_LIST_SIZE;
          // DATA-007 fix: Emit a warning when eviction occurs to distinguish
          // expected FIFO eviction from unexpected truncation in verifyIntegrity().
          try {
            // LOW-27 fix: Redact key to prevent leaking sensitive token/agent/wallet info in warnings
            process.emitWarning(
              `SqliteStore: evicting ${excess} oldest entries from list "${redactStoreKey(key)}" (MAX_LIST_SIZE=${MAX_LIST_SIZE}). ` +
              `Hash chain verification may report missing entries — this is expected eviction, not tampering.`,
              "KovaStoreEviction",
            );
          } catch { /* non-fatal */ }
          this.db
            .prepare(
              "DELETE FROM lists WHERE key = ? AND id IN (SELECT id FROM lists WHERE key = ? ORDER BY id ASC LIMIT ?)",
            )
            .run(key, key, excess);
        }
      })();
    });

    // M-20 fix: Only secure auxiliary files once instead of on every write.
    if (this.dbPath !== ":memory:") {
      this.secureAuxFilesOnce();
    }
  }

  /**
   * Get the most recent entries from a list, newest first.
   * M-19 NOTE: Uses synchronous better-sqlite3 operations that block the event loop.
   */
  async getRecent(key: string, count: number): Promise<string[]> {
    validateKey(key);
    if (count <= 0) return [];
    // MED-T5-07 fix: Cap count to MAX_LIST_SIZE to prevent loading unbounded entries
    const cappedCount = Math.min(count, MAX_LIST_SIZE);

    const rows = this.db
      .prepare(
        "SELECT value FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(key, cappedCount) as { value: string }[];

    // CRIT-09 fix: Decrypt values before returning if encryption is enabled
    return rows.map((r) => this.decrypt(r.value));
  }

  /**
   * MED-T5-09 fix: Clear all entries in a list.
   * Used by AuditLogger.clear() to properly clear the list namespace.
   */
  async clearList(key: string): Promise<void> {
    validateKey(key);
    await this.executeWithRetry(() => {
      this.db.prepare("DELETE FROM lists WHERE key = ?").run(key);
    });
  }

  /**
   * MED-23 fix: Periodically sweep expired key-value entries from the database.
   * Without periodic cleanup, expired entries accumulate on disk indefinitely
   * since TTL expiration is lazy (checked on read). Call this method on a timer
   * or cron schedule in long-running processes.
   *
   * LOW-T5-02 fix: EVENT LOOP BLOCKING WARNING — This method executes a synchronous
   * DELETE query via better-sqlite3 and will block the Node.js event loop for the
   * duration of the operation. On databases with >100K entries, this can block for
   * hundreds of milliseconds or more. For large datasets, callers should invoke this
   * method inside a worker_thread (e.g., via worker_threads.Worker) to avoid stalling
   * the main event loop. The method signature is intentionally kept synchronous to
   * avoid a breaking change.
   *
   * @returns The number of expired rows deleted.
   */
  sweepExpired(): number {
    const result = this.db
      .prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?")
      .run(Date.now());
    return result.changes;
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /**
   * T1-F5 fix: Destroy the SqliteStore by zeroing the HMAC key material and closing
   * the database connection. After calling destroy(), the store should not be used
   * for counter operations (HMAC verification will fail).
   */
  destroy(): void {
    // T1-F5 fix: Zero the HMAC key material using Buffer.fill(0) for reliable in-place
    // zeroization. Unlike strings, Buffer.fill(0) overwrites the underlying ArrayBuffer
    // bytes directly, preventing recovery from heap dumps or core dumps.
    if (this.hmacKey) {
      this.hmacKey.fill(0);
    }
    // CRIT-09 fix: Zero the encryption key material on destroy to prevent recovery
    // from heap dumps or core dumps.
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
      this.encryptionKey = null;
    }
    this.db.close();
  }

  /** Delete all data (for testing).
   *  HIGH-T5-05 fix: Wrapped in a transaction for atomicity so partial
   *  deletes (e.g., kv cleared but lists not) cannot occur on error.
   *  MED-26 fix: Emits a SecurityWarning when called, since clear() deletes all
   *  data including audit logs without any audit trail of the deletion itself.
   */
  clear(): void {
    // MED-26 fix: Emit a security warning because clear() bypasses audit trail
    // protection — an attacker with store access can silently wipe all evidence
    // (audit logs, spending counters, circuit breaker state) with no record.
    try {
      process.emitWarning(
        "SqliteStore.clear() called — all data including audit logs will be deleted. " +
        "This operation is not recorded in the audit trail.",
        "SecurityWarning",
      );
    } catch { /* non-fatal — do not block the clear operation */ }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM kv; DELETE FROM lists;");
    })();
  }
}
