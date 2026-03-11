import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../../src/stores/memory.js";
import { PrefixedStore } from "../../../src/stores/prefixed.js";

/**
 * MED-T5-05: PrefixedStore test coverage.
 *
 * Verifies that PrefixedStore correctly wraps a Store with a key prefix:
 * - Keys are prefixed with `prefix|key`
 * - Different prefixes create isolated namespaces
 * - Constructor validates prefix (empty, invalid chars, too long)
 * - `wrapIfNeeded()` returns original store when no prefix given
 * - `increment()`, `append()`, `getRecent()`, `clearList()` work through prefix
 * - MED-T5-03 fix: Keys containing `__hmac` are rejected
 */

describe("PrefixedStore", () => {
  let innerStore: MemoryStore;

  beforeEach(() => {
    // NODE_ENV=test allows MemoryStore construction without dangerouslyAllowInProduction
    innerStore = new MemoryStore();
  });

  afterEach(() => {
    innerStore.stopGc();
  });

  describe("key prefixing", () => {
    it("should prefix keys with prefix|key format", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      await prefixed.set("mykey", "myvalue");

      // The inner store should have the key stored with the prefix
      expect(await innerStore.get("wallet1|mykey")).toBe("myvalue");
      // Direct access without prefix should not find it
      expect(await innerStore.get("mykey")).toBeNull();
    });

    it("should prefix get operations", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      await innerStore.set("wallet1|mykey", "myvalue");

      expect(await prefixed.get("mykey")).toBe("myvalue");
    });

    it("should prefix set operations with TTL", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      await prefixed.set("temp", "value", 10);

      expect(await innerStore.get("wallet1|temp")).toBe("value");
    });

    it("should prefix setIfNotExists operations", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      const firstSet = await prefixed.setIfNotExists("unique", "first");
      expect(firstSet).toBe(true);

      const secondSet = await prefixed.setIfNotExists("unique", "second");
      expect(secondSet).toBe(false);

      expect(await innerStore.get("wallet1|unique")).toBe("first");
    });
  });

  describe("namespace isolation", () => {
    it("should isolate keys between different prefixes", async () => {
      const storeA = new PrefixedStore(innerStore, "walletA");
      const storeB = new PrefixedStore(innerStore, "walletB");

      await storeA.set("balance", "100");
      await storeB.set("balance", "200");

      expect(await storeA.get("balance")).toBe("100");
      expect(await storeB.get("balance")).toBe("200");
    });

    it("should isolate counters between different prefixes", async () => {
      const storeA = new PrefixedStore(innerStore, "walletA");
      const storeB = new PrefixedStore(innerStore, "walletB");

      await storeA.increment("spending", 50);
      await storeB.increment("spending", 75);

      // Each wallet's spending counter should be independent
      const resultA = await storeA.increment("spending", 10);
      const resultB = await storeB.increment("spending", 10);
      expect(resultA).toBe(60);
      expect(resultB).toBe(85);
    });

    it("should isolate lists between different prefixes", async () => {
      const storeA = new PrefixedStore(innerStore, "walletA");
      const storeB = new PrefixedStore(innerStore, "walletB");

      await storeA.append("log", "txA1");
      await storeA.append("log", "txA2");
      await storeB.append("log", "txB1");

      const logsA = await storeA.getRecent("log", 10);
      const logsB = await storeB.getRecent("log", 10);

      expect(logsA).toEqual(["txA2", "txA1"]);
      expect(logsB).toEqual(["txB1"]);
    });

    it("should not collide when prefix is a substring of another prefix", async () => {
      // Without the "|" delimiter, "ab" + "cd" === "a" + "bcd"
      // The delimiter prevents this collision
      const storeAB = new PrefixedStore(innerStore, "ab");
      const storeA = new PrefixedStore(innerStore, "a");

      await storeAB.set("cd", "from-ab");
      await storeA.set("bcd", "from-a");

      // These should be different keys in the inner store:
      // "ab|cd" vs "a|bcd"
      expect(await storeAB.get("cd")).toBe("from-ab");
      expect(await storeA.get("bcd")).toBe("from-a");
    });
  });

  describe("constructor validation", () => {
    it("should throw on empty prefix", () => {
      expect(() => new PrefixedStore(innerStore, "")).toThrow(
        /prefix must be a non-empty string/,
      );
    });

    it("should throw on prefix with invalid characters", () => {
      expect(() => new PrefixedStore(innerStore, "wallet@home")).toThrow(
        /prefix contains invalid characters/,
      );
      expect(() => new PrefixedStore(innerStore, "wallet home")).toThrow(
        /prefix contains invalid characters/,
      );
      expect(() => new PrefixedStore(innerStore, "wallet.1")).toThrow(
        /prefix contains invalid characters/,
      );
      expect(() => new PrefixedStore(innerStore, "wallet|1")).toThrow(
        /prefix contains invalid characters/,
      );
    });

    it("should throw on prefix containing the delimiter character", () => {
      expect(() => new PrefixedStore(innerStore, "a|b")).toThrow(
        /prefix contains invalid characters/,
      );
    });

    it("should throw on prefix exceeding max length (64 chars)", () => {
      const longPrefix = "a".repeat(65);
      expect(() => new PrefixedStore(innerStore, longPrefix)).toThrow(
        /prefix length .* exceeds maximum of 64/,
      );
    });

    it("should accept valid prefixes", () => {
      // Alphanumeric
      expect(() => new PrefixedStore(innerStore, "wallet123")).not.toThrow();
      // With underscores
      expect(() => new PrefixedStore(innerStore, "my_wallet")).not.toThrow();
      // With hyphens
      expect(() => new PrefixedStore(innerStore, "my-wallet")).not.toThrow();
      // With colons
      expect(() => new PrefixedStore(innerStore, "wallet:GsbwXfJr")).not.toThrow();
      // Max length (64 chars)
      expect(() => new PrefixedStore(innerStore, "a".repeat(64))).not.toThrow();
      // Single character
      expect(() => new PrefixedStore(innerStore, "x")).not.toThrow();
    });
  });

  describe("wrapIfNeeded", () => {
    it("should return original store when no prefix is given", () => {
      const result = PrefixedStore.wrapIfNeeded(innerStore);
      expect(result).toBe(innerStore);
    });

    it("should return original store when prefix is empty string", () => {
      const result = PrefixedStore.wrapIfNeeded(innerStore, "");
      expect(result).toBe(innerStore);
    });

    it("should return original store when prefix is undefined", () => {
      const result = PrefixedStore.wrapIfNeeded(innerStore, undefined);
      expect(result).toBe(innerStore);
    });

    it("should return PrefixedStore when prefix is provided", () => {
      const result = PrefixedStore.wrapIfNeeded(innerStore, "wallet1");
      expect(result).not.toBe(innerStore);
      expect(result).toBeInstanceOf(PrefixedStore);
    });

    it("should return a functional PrefixedStore when prefix is provided", async () => {
      const wrapped = PrefixedStore.wrapIfNeeded(innerStore, "wallet1");
      await wrapped.set("key", "value");
      expect(await wrapped.get("key")).toBe("value");
      // Verify it is actually prefixed in the inner store
      expect(await innerStore.get("wallet1|key")).toBe("value");
    });
  });

  describe("increment through prefixed store", () => {
    it("should increment through prefixed store and store with prefix", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      const result = await prefixed.increment("counter", 5);
      expect(result).toBe(5);

      // The inner store should have the prefixed key
      const rawValue = await innerStore.get("wallet1|counter");
      expect(rawValue).toBe("5");
    });

    it("should support sequential increments", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await prefixed.increment("spending", 10);
      await prefixed.increment("spending", 5);
      const result = await prefixed.increment("spending", 3);
      expect(result).toBe(18);
    });

    it("should store HMAC under prefixed key", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      await prefixed.increment("counter", 10);

      // The inner store's increment stores HMAC at `{key}\x00__hmac`
      // where {key} = "wallet1|counter". Verify indirectly via clean increment.
      const result = await prefixed.increment("counter", 5);
      expect(result).toBe(15);
    });
  });

  describe("append/getRecent through prefixed store", () => {
    it("should append and retrieve through prefix", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await prefixed.append("log", "entry1");
      await prefixed.append("log", "entry2");
      await prefixed.append("log", "entry3");

      const recent = await prefixed.getRecent("log", 10);
      expect(recent).toEqual(["entry3", "entry2", "entry1"]);
    });

    it("should limit getRecent count", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await prefixed.append("log", "entry1");
      await prefixed.append("log", "entry2");
      await prefixed.append("log", "entry3");

      const recent = await prefixed.getRecent("log", 2);
      expect(recent).toEqual(["entry3", "entry2"]);
    });

    it("should return empty array for non-existent list", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      expect(await prefixed.getRecent("missing", 10)).toEqual([]);
    });

    it("should append JSON strings and retrieve them correctly", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      const json = JSON.stringify({ action: "transfer", amount: "1.5" });
      await prefixed.append("log", json);

      const recent = await prefixed.getRecent("log", 1);
      expect(JSON.parse(recent[0]!)).toEqual({ action: "transfer", amount: "1.5" });
    });
  });

  describe("MED-T5-03 — __hmac key rejection", () => {
    it("should reject keys containing __hmac via get", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.get("counter:__hmac")).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys containing __hmac via set", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.set("counter:__hmac", "forged")).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys containing __hmac via setIfNotExists", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(
        prefixed.setIfNotExists("counter:__hmac", "forged"),
      ).rejects.toThrow(/direct access to internal __hmac keys is not allowed/);
    });

    it("should reject keys containing __hmac via increment", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.increment("counter:__hmac", 1)).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys containing __hmac via append", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.append("log:__hmac", "entry")).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys containing __hmac via getRecent", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.getRecent("log:__hmac", 10)).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys ending with :__hmac", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.get("spending:__hmac")).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should reject keys with __hmac embedded in the middle", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await expect(prefixed.get("some:__hmac:suffix")).rejects.toThrow(
        /direct access to internal __hmac keys is not allowed/,
      );
    });

    it("should allow keys that do not contain __hmac", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      // These should all succeed
      await prefixed.set("normal-key", "value");
      expect(await prefixed.get("normal-key")).toBe("value");

      await prefixed.set("hmac-info", "value");
      expect(await prefixed.get("hmac-info")).toBe("value");

      // "hmac" without the ":__" prefix is fine
      await prefixed.set("my-hmac-data", "value");
      expect(await prefixed.get("my-hmac-data")).toBe("value");
    });
  });

  describe("clearList delegation", () => {
    it("should delegate clearList to inner store with prefixed key", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");

      await prefixed.append("audit", "entry1");
      await prefixed.append("audit", "entry2");
      expect(await prefixed.getRecent("audit", 10)).toHaveLength(2);

      await prefixed.clearList("audit");
      expect(await prefixed.getRecent("audit", 10)).toEqual([]);
    });

    it("should not clear lists from other prefixes", async () => {
      const storeA = new PrefixedStore(innerStore, "walletA");
      const storeB = new PrefixedStore(innerStore, "walletB");

      await storeA.append("audit", "entryA");
      await storeB.append("audit", "entryB");

      // Clear only walletA's audit list
      await storeA.clearList("audit");

      expect(await storeA.getRecent("audit", 10)).toEqual([]);
      // walletB's list should be unaffected
      expect(await storeB.getRecent("audit", 10)).toEqual(["entryB"]);
    });

    it("should not error when clearing a non-existent list", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      // Should not throw
      await prefixed.clearList("nonexistent");
    });
  });

  describe("combined key length validation", () => {
    it("should reject keys that cause combined length to exceed maximum", async () => {
      // MAX_COMBINED_KEY_LENGTH is 1024. Prefix "wallet1" + "|" = 8 chars.
      // Key must be > 1024 - 8 = 1016 chars to trigger the error.
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      const longKey = "k".repeat(1017);

      await expect(prefixed.set(longKey, "value")).rejects.toThrow(
        /combined key length .* exceeds maximum/,
      );
    });

    it("should accept keys within combined length limit", async () => {
      const prefixed = new PrefixedStore(innerStore, "wallet1");
      // 8 (prefix + delimiter) + 500 = 508 total, well under 1024
      const okKey = "k".repeat(500);

      await prefixed.set(okKey, "value");
      expect(await prefixed.get(okKey)).toBe("value");
    });
  });
});
