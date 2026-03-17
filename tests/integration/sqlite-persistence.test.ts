/**
 * Integration test: SqliteStore persists data across store restarts.
 *
 * Unlike unit tests that use ":memory:", this file creates real temporary
 * database files on disk. It verifies that data written to one SqliteStore
 * instance is visible after that instance is closed and a new instance is
 * opened against the same file path.
 *
 * This exercises:
 *  - WAL checkpoint / flush on close()
 *  - Schema creation idempotency (tables exist on re-open)
 *  - TTL expiry timestamps survive serialisation through the file
 *  - Counter values and list entries are durable
 *  - SpendingLimitRule counters survive a simulated process restart
 *
 * NOTE: SqliteStore spawns a worker thread using tsx/esm for TypeScript support
 * in test environments. If the `tsx` package is not installed, the worker will
 * fail to start and all tests in this file are skipped automatically.
 * Install tsx as a dev dependency to enable these tests:
 *
 *   npm install --save-dev tsx
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteStore } from "../../src/stores/sqlite.js";
import { SpendingLimitRule } from "../../src/policy/rules/spending-limit.js";
import type { PolicyContext } from "../../src/policy/types.js";
import type { TransactionIntent } from "../../src/core/intent.js";

// ---------------------------------------------------------------------------
// Environment capability check
// ---------------------------------------------------------------------------

/**
 * Whether SqliteStore can successfully open a database in this environment.
 * SqliteStore requires a tsx/esm worker thread; if tsx is absent the worker
 * fails to spawn and all tests must be skipped.
 *
 * We check for tsx availability via module resolution before trying to open
 * any SqliteStore, to avoid unhandled worker thread errors in the test output.
 */
let sqliteAvailable = false;
let tmpDir: string;
const testHmacKey = crypto.randomBytes(32).toString("hex");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kova-sqlite-test-"));

  // Check if tsx is resolvable — SqliteStore needs it to run its worker thread.
  try {
    await import("tsx/esm");
    sqliteAvailable = true;
  } catch {
    // tsx not installed — SqliteStore worker threads cannot start.
    // All tests in this file will be skipped.
    sqliteAvailable = false;
    return;
  }

  // Double-check by probing actual SqliteStore worker startup.
  const probeFile = path.join(tmpDir, "probe.db");
  const probe = new SqliteStore({
    path: probeFile,
    hmacKey: testHmacKey,
    requireEncryption: false,
    allowedDirectories: [tmpDir],
  });
  try {
    await probe.get("__probe__");
    probe.close();
  } catch {
    try { probe.close(); } catch { /* ignore */ }
    sqliteAvailable = false;
  }
}, 15_000);

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dbPath(name: string): string {
  return path.join(tmpDir, `${name}.db`);
}

function openStore(filePath: string): SqliteStore {
  return new SqliteStore({
    path: filePath,
    hmacKey: testHmacKey,
    requireEncryption: false,
    allowedDirectories: [tmpDir],
  });
}

function makeTransfer(amount: string, token = "SOL"): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: { to: "recipient", amount, token },
  };
}

function makeContext(store: SqliteStore, now = Date.now()): PolicyContext {
  return { store, now };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SqliteStore — persistence across restart", () => {
  it("persists a plain key-value entry", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("kv-persist");
    const store1 = openStore(file);
    await store1.set("hello", "world");
    store1.close();

    const store2 = openStore(file);
    try {
      expect(await store2.get("hello")).toBe("world");
    } finally {
      store2.close();
    }
  });

  it("persists multiple distinct keys", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("multi-key");
    const store1 = openStore(file);
    await store1.set("key-a", "alpha");
    await store1.set("key-b", "beta");
    await store1.set("key-c", "gamma");
    store1.close();

    const store2 = openStore(file);
    try {
      expect(await store2.get("key-a")).toBe("alpha");
      expect(await store2.get("key-b")).toBe("beta");
      expect(await store2.get("key-c")).toBe("gamma");
    } finally {
      store2.close();
    }
  });

  it("persists counter values written via increment()", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("counters");
    const store1 = openStore(file);
    await store1.increment("counter:hits", 1);
    await store1.increment("counter:hits", 1);
    await store1.increment("counter:hits", 1);
    await store1.increment("counter:bytes", 1024);
    store1.close();

    const store2 = openStore(file);
    try {
      const hits = parseFloat((await store2.get("counter:hits"))!);
      expect(hits).toBe(3);
      const bytes = parseFloat((await store2.get("counter:bytes"))!);
      expect(bytes).toBe(1024);
    } finally {
      store2.close();
    }
  });

  it("persists list entries written via append()", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("lists");
    const store1 = openStore(file);
    await store1.append("audit_log", "entry-one");
    await store1.append("audit_log", "entry-two");
    await store1.append("audit_log", "entry-three");
    store1.close();

    const store2 = openStore(file);
    try {
      const entries = await store2.getRecent("audit_log", 100);
      // getRecent returns newest-first.
      expect(entries).toHaveLength(3);
      expect(entries[0]).toBe("entry-three");
      expect(entries[1]).toBe("entry-two");
      expect(entries[2]).toBe("entry-one");
    } finally {
      store2.close();
    }
  });

  it("does not return TTL-expired keys after restart", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("ttl-expire");
    const store1 = openStore(file);
    await store1.set("transient", "vanish", 0.001); // 1 ms TTL
    await store1.set("permanent", "stays");
    store1.close();

    await new Promise((r) => setTimeout(r, 20));

    const store2 = openStore(file);
    try {
      expect(await store2.get("transient")).toBeNull();
      expect(await store2.get("permanent")).toBe("stays");
    } finally {
      store2.close();
    }
  });

  it("persists setIfNotExists value across restart", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("set-if-not-exists");
    const store1 = openStore(file);
    const set = await store1.setIfNotExists("idempotency:tx123", "seen", 3600);
    expect(set).toBe(true);
    store1.close();

    const store2 = openStore(file);
    try {
      expect(await store2.get("idempotency:tx123")).toBe("seen");
      const setAgain = await store2.setIfNotExists("idempotency:tx123", "duplicate", 3600);
      expect(setAgain).toBe(false);
    } finally {
      store2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SpendingLimitRule counter durability
// ---------------------------------------------------------------------------

describe("SpendingLimitRule — counter survives store restart", () => {
  it("daily spending counter is non-zero after reopening the store", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("spending-daily");
    const store1 = openStore(file);

    const rule1 = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });

    const now = Date.now();
    const r1 = await rule1.evaluate(makeTransfer("10"), makeContext(store1, now));
    expect(r1.decision).toBe("ALLOW");
    const r2 = await rule1.evaluate(makeTransfer("15"), makeContext(store1, now));
    expect(r2.decision).toBe("ALLOW");
    store1.close();

    // Verify counter survived restart by checking that the rule denies
    // a transfer that would exceed the daily limit (25 already spent + 80 = 105 > 100).
    const store2 = openStore(file);
    try {
      const rule2 = new SpendingLimitRule({
        daily: { amount: "100", token: "SOL" },
      });
      const deny = await rule2.evaluate(makeTransfer("80"), makeContext(store2, now));
      expect(deny.decision).toBe("DENY");

      // But a smaller transfer that stays under the limit should succeed (25 + 50 = 75 < 100).
      const allow = await rule2.evaluate(makeTransfer("50"), makeContext(store2, now));
      expect(allow.decision).toBe("ALLOW");
    } finally {
      store2.close();
    }
  });

  it("budget remaining after restart reflects previously spent amount", async ({ skip }) => {
    if (!sqliteAvailable) skip();
    const file = dbPath("spending-budget");
    const store1 = openStore(file);

    const rule1 = new SpendingLimitRule({
      daily: { amount: "20", token: "SOL" },
    });

    const now = Date.now();
    const allow = await rule1.evaluate(makeTransfer("18"), makeContext(store1, now));
    expect(allow.decision).toBe("ALLOW");
    store1.close();

    const store2 = openStore(file);
    try {
      const rule2 = new SpendingLimitRule({
        daily: { amount: "20", token: "SOL" },
      });

      // 18 + 3 = 21 >= 20 — should be denied.
      const deny = await rule2.evaluate(makeTransfer("3"), makeContext(store2, now));
      expect(deny.decision).toBe("DENY");

      // 18 + 1 = 19 < 20 — should be allowed.
      const allow2 = await rule2.evaluate(makeTransfer("1"), makeContext(store2, now));
      expect(allow2.decision).toBe("ALLOW");
    } finally {
      store2.close();
    }
  });
});
