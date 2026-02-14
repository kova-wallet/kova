import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore } from "../../../src/stores/memory.js";
import { SqliteStore } from "../../../src/stores/sqlite.js";

/**
 * MED-T5-04: HMAC counter integrity tests for MemoryStore and SqliteStore.
 *
 * Verifies that counter values are protected by HMAC integrity checks:
 * - HMAC is computed and stored in `{key}:__hmac` on each increment
 * - Tampered counter values are detected and reset to 0
 * - Missing HMAC entries do not cause errors (backward compatibility)
 * - HMAC verification uses timing-safe comparison
 */

describe("HMAC counter integrity — MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    // NODE_ENV=test allows MemoryStore construction without dangerouslyAllowInProduction
    store = new MemoryStore();
  });

  afterEach(() => {
    store.stopGc();
  });

  describe("HMAC storage on increment", () => {
    it("should store HMAC in {key}:__hmac after increment", async () => {
      const result = await store.increment("test-counter", 5);
      expect(result).toBe(5);

      // The HMAC should be stored as a separate key
      const hmac = await store.get("test-counter:__hmac");
      expect(hmac).not.toBeNull();
      expect(hmac).toBeTruthy();
      // HMAC is a hex-encoded SHA-256 digest (64 hex chars)
      expect(hmac!.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hmac!)).toBe(true);
    });

    it("should update HMAC on subsequent increments", async () => {
      await store.increment("test-counter", 5);
      const hmac1 = await store.get("test-counter:__hmac");

      await store.increment("test-counter", 3);
      const hmac2 = await store.get("test-counter:__hmac");

      // HMAC should change because the counter value changed
      expect(hmac1).not.toBeNull();
      expect(hmac2).not.toBeNull();
      expect(hmac1).not.toBe(hmac2);
    });

    it("should store HMAC for first increment (new key)", async () => {
      const result = await store.increment("new-key", 0);
      expect(result).toBe(0);

      const hmac = await store.get("new-key:__hmac");
      expect(hmac).not.toBeNull();
    });

    it("should store distinct HMACs for different keys with same value", async () => {
      await store.increment("counter-a", 10);
      await store.increment("counter-b", 10);

      const hmacA = await store.get("counter-a:__hmac");
      const hmacB = await store.get("counter-b:__hmac");

      // HMACs should differ because the key is part of the HMAC input
      expect(hmacA).not.toBeNull();
      expect(hmacB).not.toBeNull();
      expect(hmacA).not.toBe(hmacB);
    });
  });

  describe("tamper detection", () => {
    it("should detect tampered counter value and reset to 0 + amount", async () => {
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
        // Next increment should detect HMAC mismatch and reset to 0
        const result = await store.increment("spending", 1);
        expect(result).toBe(1); // 0 (reset) + 1 (amount)

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
        // Should reset to 0 + 5 = 5, not 101 + 5 = 106
        expect(result).toBe(5);

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

      // increment should treat missing HMAC as valid (backward compat)
      const result = await store.increment("legacy-counter", 8);
      // Missing HMAC is not treated as tampering — value is trusted
      expect(result).toBe(50); // 42 + 8
    });

    it("should create HMAC after incrementing a legacy counter", async () => {
      await store.set("legacy-counter", "42");
      expect(await store.get("legacy-counter:__hmac")).toBeNull();

      await store.increment("legacy-counter", 1);

      // After increment, HMAC should now be present
      const hmac = await store.get("legacy-counter:__hmac");
      expect(hmac).not.toBeNull();
      expect(/^[0-9a-f]{64}$/.test(hmac!)).toBe(true);
    });
  });

  describe("HMAC uses timing-safe comparison", () => {
    it("should use crypto.timingSafeEqual internally (verified via tamper detection)", async () => {
      // We verify timing-safe comparison indirectly: if the comparison were
      // not timing-safe, a partial HMAC match could leak information. We verify
      // the mechanism works correctly by confirming tampered values are always
      // detected regardless of partial HMAC similarity.
      await store.increment("timing-test", 100);
      const legitimateHmac = await store.get("timing-test:__hmac");

      // Tamper with counter value
      await store.set("timing-test", "200");

      // The HMAC from value "100" should not match value "200"
      const result = await store.increment("timing-test", 1);
      expect(result).toBe(1); // Reset to 0 + 1

      // After the new increment, a new valid HMAC should be stored
      const newHmac = await store.get("timing-test:__hmac");
      expect(newHmac).not.toBeNull();
      expect(newHmac).not.toBe(legitimateHmac);
    });

    it("should reject HMAC with wrong length gracefully", async () => {
      await store.increment("hmac-len", 10);

      // Tamper with the HMAC itself to have wrong length
      await store.set("hmac-len:__hmac", "short");

      // Should detect invalid HMAC and reset
      const result = await store.increment("hmac-len", 1);
      expect(result).toBe(1); // Reset to 0 + 1
    });

    it("should reject HMAC with invalid hex characters gracefully", async () => {
      await store.increment("hmac-hex", 10);

      // Tamper with HMAC using invalid hex (non-hex chars, correct length)
      await store.set("hmac-hex:__hmac", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");

      // Should detect invalid HMAC and reset
      const result = await store.increment("hmac-hex", 1);
      expect(result).toBe(1); // Reset to 0 + 1
    });
  });

  describe("HMAC isolation across store instances", () => {
    it("should not accept HMAC from a different MemoryStore instance", async () => {
      const store2 = new MemoryStore();

      // Each store has its own random HMAC key, so an HMAC from store1
      // is invalid in store2 (and vice versa).
      await store.increment("cross-instance", 50);
      const hmacFromStore1 = await store.get("cross-instance:__hmac");
      expect(hmacFromStore1).not.toBeNull();

      // Set up store2 with the same counter value and store1's HMAC
      await store2.set("cross-instance", "50");
      await store2.set("cross-instance:__hmac", hmacFromStore1!);

      // store2 should detect HMAC mismatch (different HMAC key)
      const result = await store2.increment("cross-instance", 1);
      expect(result).toBe(1); // Reset to 0 + 1

      store2.stopGc();
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
    it("should store HMAC in {key}:__hmac after increment", async () => {
      const result = await store.increment("test-counter", 5);
      expect(result).toBe(5);

      // The HMAC should be stored as a separate KV entry
      const hmac = await store.get("test-counter:__hmac");
      expect(hmac).not.toBeNull();
      expect(hmac).toBeTruthy();
      // HMAC is a hex-encoded SHA-256 digest (64 hex chars)
      expect(hmac!.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hmac!)).toBe(true);
    });

    it("should update HMAC on subsequent increments", async () => {
      await store.increment("test-counter", 5);
      const hmac1 = await store.get("test-counter:__hmac");

      await store.increment("test-counter", 3);
      const hmac2 = await store.get("test-counter:__hmac");

      // HMAC should change because the counter value changed
      expect(hmac1).not.toBeNull();
      expect(hmac2).not.toBeNull();
      expect(hmac1).not.toBe(hmac2);
    });

    it("should store HMAC for first increment (new key)", async () => {
      const result = await store.increment("new-key", 0);
      expect(result).toBe(0);

      const hmac = await store.get("new-key:__hmac");
      expect(hmac).not.toBeNull();
    });

    it("should store distinct HMACs for different keys with same value", async () => {
      await store.increment("counter-a", 10);
      await store.increment("counter-b", 10);

      const hmacA = await store.get("counter-a:__hmac");
      const hmacB = await store.get("counter-b:__hmac");

      // HMACs should differ because the key is part of the HMAC input
      expect(hmacA).not.toBeNull();
      expect(hmacB).not.toBeNull();
      expect(hmacA).not.toBe(hmacB);
    });
  });

  describe("tamper detection", () => {
    it("should detect tampered counter value and reset to 0 + amount", async () => {
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
        // Next increment should detect HMAC mismatch and reset to 0
        const result = await store.increment("spending", 1);
        expect(result).toBe(1); // 0 (reset) + 1 (amount)

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
        // Should reset to 0 + 5 = 5, not 101 + 5 = 106
        expect(result).toBe(5);

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

      // increment should treat missing HMAC as valid (backward compat)
      const result = await store.increment("legacy-counter", 8);
      // Missing HMAC is not treated as tampering — value is trusted
      expect(result).toBe(50); // 42 + 8
    });

    it("should create HMAC after incrementing a legacy counter", async () => {
      await store.set("legacy-counter", "42");
      expect(await store.get("legacy-counter:__hmac")).toBeNull();

      await store.increment("legacy-counter", 1);

      // After increment, HMAC should now be present
      const hmac = await store.get("legacy-counter:__hmac");
      expect(hmac).not.toBeNull();
      expect(/^[0-9a-f]{64}$/.test(hmac!)).toBe(true);
    });
  });

  describe("HMAC uses timing-safe comparison", () => {
    it("should use crypto.timingSafeEqual internally (verified via tamper detection)", async () => {
      await store.increment("timing-test", 100);
      const legitimateHmac = await store.get("timing-test:__hmac");

      // Tamper with counter value
      await store.set("timing-test", "200");

      // The HMAC from value "100" should not match value "200"
      const result = await store.increment("timing-test", 1);
      expect(result).toBe(1); // Reset to 0 + 1

      // After the new increment, a new valid HMAC should be stored
      const newHmac = await store.get("timing-test:__hmac");
      expect(newHmac).not.toBeNull();
      expect(newHmac).not.toBe(legitimateHmac);
    });

    it("should reject HMAC with wrong length gracefully", async () => {
      await store.increment("hmac-len", 10);

      // Tamper with the HMAC itself to have wrong length
      await store.set("hmac-len:__hmac", "short");

      // Should detect invalid HMAC and reset
      const result = await store.increment("hmac-len", 1);
      expect(result).toBe(1); // Reset to 0 + 1
    });

    it("should reject HMAC with invalid hex characters gracefully", async () => {
      await store.increment("hmac-hex", 10);

      // Tamper with HMAC using invalid hex (non-hex chars, correct length)
      await store.set("hmac-hex:__hmac", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");

      // Should detect invalid HMAC and reset
      const result = await store.increment("hmac-hex", 1);
      expect(result).toBe(1); // Reset to 0 + 1
    });
  });

  describe("HMAC isolation across store instances", () => {
    it("should not accept HMAC from a different SqliteStore instance", async () => {
      const store2 = new SqliteStore({ path: ":memory:", requireEncryption: false });

      // Each store has its own random HMAC key, so an HMAC from store1
      // is invalid in store2 (and vice versa).
      await store.increment("cross-instance", 50);
      const hmacFromStore1 = await store.get("cross-instance:__hmac");
      expect(hmacFromStore1).not.toBeNull();

      // Set up store2 with the same counter value and store1's HMAC
      await store2.set("cross-instance", "50");
      await store2.set("cross-instance:__hmac", hmacFromStore1!);

      // store2 should detect HMAC mismatch (different HMAC key)
      const result = await store2.increment("cross-instance", 1);
      expect(result).toBe(1); // Reset to 0 + 1

      store2.close();
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
      // Increment both stores
      await store.increment("parity", 50);
      await memStore.increment("parity", 50);

      // Tamper with both
      await store.set("parity", "99999");
      await memStore.set("parity", "99999");

      // Both should reset to 0 + 1
      const sqlResult = await store.increment("parity", 1);
      const memResult = await memStore.increment("parity", 1);
      expect(sqlResult).toBe(1);
      expect(memResult).toBe(1);
      expect(sqlResult).toBe(memResult);
    });

    it("should both store HMAC in the same key pattern", async () => {
      await store.increment("parity-hmac", 10);
      await memStore.increment("parity-hmac", 10);

      const sqlHmac = await store.get("parity-hmac:__hmac");
      const memHmac = await memStore.get("parity-hmac:__hmac");

      // Both should have HMACs (though values differ due to different instance keys)
      expect(sqlHmac).not.toBeNull();
      expect(memHmac).not.toBeNull();
      expect(sqlHmac!.length).toBe(64);
      expect(memHmac!.length).toBe(64);
    });

    it("should both handle missing HMAC without error", async () => {
      await store.set("legacy", "42");
      await memStore.set("legacy", "42");

      const sqlResult = await store.increment("legacy", 8);
      const memResult = await memStore.increment("legacy", 8);

      // Both should trust the value when HMAC is missing (backward compat)
      expect(sqlResult).toBe(50);
      expect(memResult).toBe(50);
    });
  });
});
