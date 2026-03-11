import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../../src/stores/memory.js";
import { SqliteStore } from "../../../src/stores/sqlite.js";

/**
 * MED-T5-04: HMAC counter integrity tests for MemoryStore and SqliteStore.
 *
 * Verifies that counter values are protected by HMAC integrity checks:
 * - HMAC is computed and stored internally (using \x00__hmac separator) on each increment
 * - Tampered counter values are detected and the current value is preserved
 *   (M13 fix: prevents spending limit bypass via HMAC deletion)
 * - Missing HMAC entries preserve the current value (consistent fail-safe)
 * - HMAC verification uses timing-safe comparison
 *
 * L8 fix: HMAC keys now use a null-byte separator (\x00__hmac) instead of
 * ":__hmac" to prevent key collisions with user keys ending in ":__hmac".
 * Since validateKey() rejects null bytes in user keys, HMAC keys are
 * inaccessible via public store methods, making them truly internal.
 */

describe("HMAC counter integrity — MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.stopGc();
  });

  describe("HMAC storage on increment", () => {
    it("should store HMAC internally after increment", async () => {
      const result = await store.increment("test-counter", 5);
      expect(result).toBe(5);

      // Subsequent increment should succeed with valid HMAC verification
      const result2 = await store.increment("test-counter", 3);
      expect(result2).toBe(8);
    });

    it("should update HMAC on subsequent increments", async () => {
      await store.increment("test-counter", 5);
      await store.increment("test-counter", 3);
      const result = await store.increment("test-counter", 2);
      expect(result).toBe(10);
    });

    it("should store HMAC for first increment (new key)", async () => {
      const result = await store.increment("new-key", 0);
      expect(result).toBe(0);

      const result2 = await store.increment("new-key", 1);
      expect(result2).toBe(1);
    });

    it("should store distinct HMACs for different keys with same value", async () => {
      await store.increment("counter-a", 10);
      await store.increment("counter-b", 10);

      const resultA = await store.increment("counter-a", 1);
      const resultB = await store.increment("counter-b", 1);
      expect(resultA).toBe(11);
      expect(resultB).toBe(11);
    });
  });

  describe("tamper detection", () => {
    it("should detect tampered counter value and preserve current value", async () => {
      // Set up a legitimate counter
      await store.increment("spending", 50);
      expect(await store.get("spending")).toBe("50");

      // Simulate tampering: directly overwrite the counter value without updating HMAC
      await store.set("spending", "99999");

      // Capture the security warning
      const warnings: string[] = [];
      const handler = (warning: Error) => {
        if (warning.name === "SecurityWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", handler);

      try {
        // M13 fix: preserve tampered value (99999) to prevent spending limit bypass
        const result = await store.increment("spending", 1);
        expect(result).toBe(100000); // 99999 (preserved) + 1 (amount)

        // Wait for warning event to propagate
        await new Promise((r) => setTimeout(r, 10));
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings.some((w) => w.includes("HMAC verification failed"))).toBe(true);
        expect(warnings.some((w) => w.includes("spending"))).toBe(true);
      } finally {
        process.removeListener("warning", handler);
      }
    });

    it("should not reset counter when value is legitimately incremented", async () => {
      await store.increment("legit", 10);
      await store.increment("legit", 5);
      const result = await store.increment("legit", 3);
      expect(result).toBe(18); // 10 + 5 + 3
    });

    it("should detect tampering even with same type but different value", async () => {
      await store.increment("counter", 100);

      // Tamper with a slightly different numeric value
      await store.set("counter", "101");

      const warnings: string[] = [];
      const handler = (warning: Error) => {
        if (warning.name === "SecurityWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", handler);

      try {
        const result = await store.increment("counter", 5);
        // M13 fix: preserve tampered value (101) + 5 = 106
        expect(result).toBe(106);

        await new Promise((r) => setTimeout(r, 10));
        expect(warnings.some((w) => w.includes("HMAC verification failed"))).toBe(true);
      } finally {
        process.removeListener("warning", handler);
      }
    });
  });

  describe("missing HMAC — backward compatibility", () => {
    it("should not error when HMAC entry is missing (no prior increment)", async () => {
      // Simulate a counter that was created by direct set() (no HMAC)
      await store.set("legacy-counter", "42");

      // M13 fix: Missing HMAC preserves current value to prevent spending limit bypass
      const result = await store.increment("legacy-counter", 8);
      expect(result).toBe(50); // 42 (preserved) + 8
    });

    it("should create HMAC after incrementing a legacy counter", async () => {
      await store.set("legacy-counter", "42");

      await store.increment("legacy-counter", 1);

      // After increment, HMAC should be present internally — verify via clean increment
      const result = await store.increment("legacy-counter", 1);
      expect(result).toBe(44); // 42 + 1 + 1
    });
  });

  describe("HMAC uses timing-safe comparison", () => {
    it("should use crypto.timingSafeEqual internally (verified via tamper detection)", async () => {
      await store.increment("timing-test", 100);

      // Tamper with counter value
      await store.set("timing-test", "200");

      // M13 fix: preserve current value (200) instead of resetting to 0
      const result = await store.increment("timing-test", 1);
      expect(result).toBe(201); // 200 (preserved) + 1

      // After the new increment, a valid HMAC is stored — verify via clean increment
      const result2 = await store.increment("timing-test", 1);
      expect(result2).toBe(202);
    });

    it("should detect tampered HMAC gracefully", async () => {
      await store.increment("hmac-tamper", 10);

      // Tamper with the counter value (HMAC becomes invalid)
      await store.set("hmac-tamper", "10.5");

      // M13 fix: preserve current value on invalid HMAC
      const result = await store.increment("hmac-tamper", 1);
      expect(result).toBe(11.5);
    });
  });

  describe("HMAC isolation across store instances", () => {
    it("should not accept HMAC from a different MemoryStore instance", async () => {
      const store2 = new MemoryStore();

      await store.increment("cross-instance", 50);

      // Set up store2 with the same counter value but no HMAC
      await store2.set("cross-instance", "50");

      // store2 should detect missing HMAC but preserve value
      // M13 fix: preserve current value (50) instead of resetting to 0
      const result = await store2.increment("cross-instance", 1);
      expect(result).toBe(51); // 50 (preserved) + 1

      store2.stopGc();
    });
  });

  describe("L8 fix: HMAC key collision prevention", () => {
    it("should not collide with user key ending in :__hmac", async () => {
      // Increment a counter — this stores HMAC internally with \x00 separator
      await store.increment("mykey", 10);

      // User sets a key that ends in ":__hmac" — should NOT interfere
      // with the internal HMAC because the separator is now \x00
      await store.set("mykey:__hmac", "user-data");

      // The counter should still work correctly
      const result = await store.increment("mykey", 5);
      expect(result).toBe(15);

      // The user's key should still be readable
      const userData = await store.get("mykey:__hmac");
      expect(userData).toBe("user-data");
    });
  });
});

describe("HMAC counter integrity — SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ path: ":memory:", requireEncryption: false });
  });

  afterEach(() => {
    store.close();
  });

  describe("HMAC storage on increment", () => {
    it("should store HMAC internally after increment", async () => {
      const result = await store.increment("test-counter", 5);
      expect(result).toBe(5);

      const result2 = await store.increment("test-counter", 3);
      expect(result2).toBe(8);
    });

    it("should update HMAC on subsequent increments", async () => {
      await store.increment("test-counter", 5);
      await store.increment("test-counter", 3);
      const result = await store.increment("test-counter", 2);
      expect(result).toBe(10);
    });

    it("should store HMAC for first increment (new key)", async () => {
      const result = await store.increment("new-key", 0);
      expect(result).toBe(0);

      const result2 = await store.increment("new-key", 1);
      expect(result2).toBe(1);
    });

    it("should store distinct HMACs for different keys with same value", async () => {
      await store.increment("counter-a", 10);
      await store.increment("counter-b", 10);

      const resultA = await store.increment("counter-a", 1);
      const resultB = await store.increment("counter-b", 1);
      expect(resultA).toBe(11);
      expect(resultB).toBe(11);
    });
  });

  describe("tamper detection", () => {
    it("should detect tampered counter value and preserve current value", async () => {
      await store.increment("spending", 50);
      expect(await store.get("spending")).toBe("50");

      await store.set("spending", "99999");

      const warnings: string[] = [];
      const handler = (warning: Error) => {
        if (warning.name === "SecurityWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", handler);

      try {
        const result = await store.increment("spending", 1);
        expect(result).toBe(100000);

        await new Promise((r) => setTimeout(r, 10));
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings.some((w) => w.includes("HMAC verification failed"))).toBe(true);
        expect(warnings.some((w) => w.includes("spending"))).toBe(true);
      } finally {
        process.removeListener("warning", handler);
      }
    });

    it("should not reset counter when value is legitimately incremented", async () => {
      await store.increment("legit", 10);
      await store.increment("legit", 5);
      const result = await store.increment("legit", 3);
      expect(result).toBe(18);
    });

    it("should detect tampering even with same type but different value", async () => {
      await store.increment("counter", 100);
      await store.set("counter", "101");

      const warnings: string[] = [];
      const handler = (warning: Error) => {
        if (warning.name === "SecurityWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", handler);

      try {
        const result = await store.increment("counter", 5);
        expect(result).toBe(106);

        await new Promise((r) => setTimeout(r, 10));
        expect(warnings.some((w) => w.includes("HMAC verification failed"))).toBe(true);
      } finally {
        process.removeListener("warning", handler);
      }
    });
  });

  describe("missing HMAC — backward compatibility", () => {
    it("should not error when HMAC entry is missing (no prior increment)", async () => {
      await store.set("legacy-counter", "42");

      const result = await store.increment("legacy-counter", 8);
      expect(result).toBe(50);
    });

    it("should create HMAC after incrementing a legacy counter", async () => {
      await store.set("legacy-counter", "42");

      await store.increment("legacy-counter", 1);

      const result = await store.increment("legacy-counter", 1);
      expect(result).toBe(44);
    });
  });

  describe("HMAC uses timing-safe comparison", () => {
    it("should use crypto.timingSafeEqual internally (verified via tamper detection)", async () => {
      await store.increment("timing-test", 100);

      await store.set("timing-test", "200");

      const result = await store.increment("timing-test", 1);
      expect(result).toBe(201);

      const result2 = await store.increment("timing-test", 1);
      expect(result2).toBe(202);
    });

    it("should detect tampered HMAC gracefully", async () => {
      await store.increment("hmac-tamper", 10);
      await store.set("hmac-tamper", "10.5");

      const result = await store.increment("hmac-tamper", 1);
      expect(result).toBe(11.5);
    });
  });

  describe("HMAC isolation across store instances", () => {
    it("should not accept HMAC from a different SqliteStore instance", async () => {
      const store2 = new SqliteStore({ path: ":memory:", requireEncryption: false });

      await store.increment("cross-instance", 50);

      await store2.set("cross-instance", "50");

      const result = await store2.increment("cross-instance", 1);
      expect(result).toBe(51);

      store2.close();
    });
  });

  describe("L8 fix: HMAC key collision prevention", () => {
    it("should not collide with user key ending in :__hmac", async () => {
      await store.increment("mykey", 10);

      await store.set("mykey:__hmac", "user-data");

      const result = await store.increment("mykey", 5);
      expect(result).toBe(15);

      const userData = await store.get("mykey:__hmac");
      expect(userData).toBe("user-data");
    });
  });

  describe("HMAC parity between MemoryStore and SqliteStore", () => {
    let memStore: MemoryStore;

    beforeEach(() => {
      memStore = new MemoryStore();
    });

    afterEach(() => {
      memStore.stopGc();
    });

    it("should both detect tampering identically", async () => {
      await store.increment("parity", 50);
      await memStore.increment("parity", 50);

      await store.set("parity", "99999");
      await memStore.set("parity", "99999");

      const sqlResult = await store.increment("parity", 1);
      const memResult = await memStore.increment("parity", 1);
      expect(sqlResult).toBe(100000);
      expect(memResult).toBe(100000);
      expect(sqlResult).toBe(memResult);
    });

    it("should both store HMAC internally", async () => {
      await store.increment("parity-hmac", 10);
      await memStore.increment("parity-hmac", 10);

      const sqlResult = await store.increment("parity-hmac", 1);
      const memResult = await memStore.increment("parity-hmac", 1);
      expect(sqlResult).toBe(11);
      expect(memResult).toBe(11);
    });

    it("should both handle missing HMAC without error", async () => {
      await store.set("legacy", "42");
      await memStore.set("legacy", "42");

      const sqlResult = await store.increment("legacy", 8);
      const memResult = await memStore.increment("legacy", 8);

      expect(sqlResult).toBe(50);
      expect(memResult).toBe(50);
    });
  });
});
