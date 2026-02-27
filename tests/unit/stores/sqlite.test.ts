import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../../../src/stores/sqlite.js";
import { MemoryStore } from "../../../src/stores/memory.js";

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ path: ":memory:", requireEncryption: false });
  });

  afterEach(() => {
    store.close();
  });

  describe("get/set", () => {
    it("should return null for non-existent key", async () => {
      expect(await store.get("missing")).toBeNull();
    });

    it("should store and retrieve a value", async () => {
      await store.set("key1", "value1");
      expect(await store.get("key1")).toBe("value1");
    });

    it("should overwrite existing values", async () => {
      await store.set("key1", "value1");
      await store.set("key1", "value2");
      expect(await store.get("key1")).toBe("value2");
    });

    it("should expire values after TTL", async () => {
      await store.set("key1", "value1", 0.001); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("key1")).toBeNull();
    });

    it("should not expire values without TTL", async () => {
      await store.set("key1", "value1");
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("key1")).toBe("value1");
    });
  });

  describe("increment", () => {
    it("should create key with initial amount if not exists", async () => {
      const result = await store.increment("counter", 5);
      expect(result).toBe(5);
    });

    it("should increment existing value", async () => {
      await store.increment("counter", 5);
      const result = await store.increment("counter", 3);
      expect(result).toBe(8);
    });

    it("should handle negative increments (decrement)", async () => {
      await store.increment("counter", 10);
      const result = await store.increment("counter", -3);
      expect(result).toBe(7);
    });

    it("should handle floating point amounts", async () => {
      await store.increment("counter", 1.5);
      const result = await store.increment("counter", 0.3);
      expect(result).toBeCloseTo(1.8);
    });

    it("should handle increment by zero", async () => {
      await store.increment("counter", 5);
      const result = await store.increment("counter", 0);
      expect(result).toBe(5);
    });

    it("should handle first increment by zero", async () => {
      const result = await store.increment("counter", 0);
      expect(result).toBe(0);
    });

    it("should handle multiple sequential increments", async () => {
      for (let i = 1; i <= 10; i++) {
        await store.increment("counter", 1);
      }
      const value = await store.get("counter");
      expect(parseFloat(value!)).toBe(10);
    });

    it("should preserve TTL on increment of key with TTL", async () => {
      await store.set("counter", "5", 10);
      const result = await store.increment("counter", 3);
      expect(result).toBe(8);
      expect(await store.get("counter")).toBe("8");
    });

    it("should handle increment of expired key", async () => {
      await store.set("counter", "100", 0.001);
      await new Promise((r) => setTimeout(r, 10));
      const result = await store.increment("counter", 5);
      expect(result).toBe(5);
    });

    it("should handle increment with non-numeric existing value", async () => {
      await store.set("key", "not-a-number");
      const result = await store.increment("key", 5);
      expect(result).toBe(5);
    });
  });

  describe("append/getRecent", () => {
    it("should return empty array for non-existent list", async () => {
      expect(await store.getRecent("list", 10)).toEqual([]);
    });

    it("should append and retrieve entries", async () => {
      await store.append("list", "entry1");
      await store.append("list", "entry2");
      await store.append("list", "entry3");

      const recent = await store.getRecent("list", 10);
      expect(recent).toEqual(["entry3", "entry2", "entry1"]);
    });

    it("should limit the number of returned entries", async () => {
      await store.append("list", "entry1");
      await store.append("list", "entry2");
      await store.append("list", "entry3");

      const recent = await store.getRecent("list", 2);
      expect(recent).toEqual(["entry3", "entry2"]);
    });

    it("should return entries in reverse chronological order", async () => {
      await store.append("log", "first");
      await store.append("log", "second");
      await store.append("log", "third");

      const recent = await store.getRecent("log", 3);
      expect(recent[0]).toBe("third");
      expect(recent[2]).toBe("first");
    });

    it("should return empty array when count is 0", async () => {
      await store.append("list", "entry1");
      expect(await store.getRecent("list", 0)).toEqual([]);
    });

    it("should handle getRecent with count larger than list size", async () => {
      await store.append("list", "entry1");
      const recent = await store.getRecent("list", 100);
      expect(recent).toEqual(["entry1"]);
    });

    it("should handle append of empty string", async () => {
      await store.append("list", "");
      const recent = await store.getRecent("list", 10);
      expect(recent).toEqual([""]);
    });

    it("should handle append of JSON strings", async () => {
      const json = JSON.stringify({ action: "transfer", amount: "1.5" });
      await store.append("list", json);
      const recent = await store.getRecent("list", 10);
      expect(JSON.parse(recent[0]!)).toEqual({ action: "transfer", amount: "1.5" });
    });

    it("should maintain separate lists for different keys", async () => {
      await store.append("list1", "a");
      await store.append("list2", "b");
      expect(await store.getRecent("list1", 10)).toEqual(["a"]);
      expect(await store.getRecent("list2", 10)).toEqual(["b"]);
    });

    it("should handle large number of appends", async () => {
      for (let i = 0; i < 100; i++) {
        await store.append("biglist", `entry-${i}`);
      }
      const recent = await store.getRecent("biglist", 5);
      expect(recent).toHaveLength(5);
      expect(recent[0]).toBe("entry-99");
      expect(recent[4]).toBe("entry-95");
    });

    it("should handle getRecent with count of 1", async () => {
      await store.append("list", "first");
      await store.append("list", "second");
      await store.append("list", "third");
      const recent = await store.getRecent("list", 1);
      expect(recent).toEqual(["third"]);
    });
  });

  describe("TTL edge cases", () => {
    it("should throw when ttlSeconds is zero (MED-08)", async () => {
      await expect(store.set("key1", "value1", 0)).rejects.toThrow(
        "ttlSeconds must be a positive finite number",
      );
    });

    it("should throw when ttlSeconds is negative (MED-08)", async () => {
      await expect(store.set("key1", "value1", -5)).rejects.toThrow(
        "ttlSeconds must be a positive finite number",
      );
    });

    it("should overwrite TTL when re-setting with new TTL", async () => {
      await store.set("key1", "value1", 0.001);
      await store.set("key1", "value2"); // no TTL = permanent
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("key1")).toBe("value2");
    });
  });

  describe("key isolation", () => {
    it("should keep key-value store and list store independent", async () => {
      await store.set("mykey", "myvalue");
      await store.append("mykey", "listvalue");

      expect(await store.get("mykey")).toBe("myvalue");
      expect(await store.getRecent("mykey", 10)).toEqual(["listvalue"]);
    });

    it("should handle special characters in keys", async () => {
      await store.set("key:with:colons", "value1");
      await store.set("key/with/slashes", "value2");
      await store.set("key.with.dots", "value3");

      expect(await store.get("key:with:colons")).toBe("value1");
      expect(await store.get("key/with/slashes")).toBe("value2");
      expect(await store.get("key.with.dots")).toBe("value3");
    });

    it("should handle empty string key", async () => {
      await store.set("", "value");
      expect(await store.get("")).toBe("value");
    });
  });

  describe("clear", () => {
    it("should remove all data", async () => {
      await store.set("key1", "value1");
      await store.append("list", "entry1");
      store.clear();

      expect(await store.get("key1")).toBeNull();
      expect(await store.getRecent("list", 10)).toEqual([]);
    });

    it("should allow operations after clear", async () => {
      await store.set("key1", "value1");
      store.clear();

      await store.set("key2", "value2");
      expect(await store.get("key2")).toBe("value2");
    });
  });

  // ── Very Long Keys and Values ──────────────────────────────────

  describe("very long keys and values", () => {
    it("should reject a very long key (1000 chars) exceeding max length", async () => {
      const longKey = "k".repeat(1000);
      await expect(store.set(longKey, "value")).rejects.toThrow(
        /Store key exceeds max length of 512/,
      );
    });

    it("should handle a very long value (10000 chars)", async () => {
      const longValue = "v".repeat(10000);
      await store.set("longval", longValue);
      expect(await store.get("longval")).toBe(longValue);
    });

    it("should handle very long key for append/getRecent", async () => {
      const longKey = "list-" + "x".repeat(500);
      await store.append(longKey, "entry1");
      await store.append(longKey, "entry2");
      const recent = await store.getRecent(longKey, 10);
      expect(recent).toEqual(["entry2", "entry1"]);
    });

    it("should handle very long value for append/getRecent", async () => {
      const longValue = JSON.stringify({ data: "x".repeat(5000) });
      await store.append("biglist", longValue);
      const recent = await store.getRecent("biglist", 1);
      expect(recent[0]).toBe(longValue);
    });

    it("should handle unicode keys and values", async () => {
      const unicodeKey = "key-\u{1F600}-\u{1F4B0}";
      const unicodeValue = "value-\u{2603}-\u{2764}";
      await store.set(unicodeKey, unicodeValue);
      expect(await store.get(unicodeKey)).toBe(unicodeValue);
    });
  });

  // ── Concurrent Operations ──────────────────────────────────

  describe("concurrent operations", () => {
    it("should handle concurrent set operations on different keys", async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(store.set(`concurrent-key-${i}`, `value-${i}`));
      }
      await Promise.all(promises);

      for (let i = 0; i < 50; i++) {
        expect(await store.get(`concurrent-key-${i}`)).toBe(`value-${i}`);
      }
    });

    it("should handle concurrent increments on the same key", async () => {
      // Each increment adds 1, done 20 times concurrently
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(store.increment("concurrent-counter", 1));
      }
      await Promise.all(promises);

      const value = await store.get("concurrent-counter");
      expect(parseFloat(value!)).toBe(20);
    });

    it("should handle concurrent appends to the same list", async () => {
      const promises = [];
      for (let i = 0; i < 30; i++) {
        promises.push(store.append("concurrent-list", `entry-${i}`));
      }
      await Promise.all(promises);

      const recent = await store.getRecent("concurrent-list", 100);
      expect(recent).toHaveLength(30);
    });

    it("should handle mixed concurrent reads and writes", async () => {
      await store.set("mix-key", "initial");
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(store.get("mix-key"));
        promises.push(store.set("mix-key", `value-${i}`));
      }
      await Promise.all(promises);

      // After all operations, the key should have some value
      const finalValue = await store.get("mix-key");
      expect(finalValue).toBeDefined();
      expect(finalValue).not.toBeNull();
    });
  });

  // ── SqliteStore / MemoryStore Parity ──────────────────────────────────

  describe("SqliteStore and MemoryStore parity", () => {
    let memStore: MemoryStore;

    beforeEach(() => {
      memStore = new MemoryStore();
    });

    it("should both return null for non-existent keys", async () => {
      expect(await store.get("missing")).toEqual(await memStore.get("missing"));
    });

    it("should both store and retrieve the same value", async () => {
      await store.set("parity-key", "parity-value");
      await memStore.set("parity-key", "parity-value");

      expect(await store.get("parity-key")).toBe(await memStore.get("parity-key"));
    });

    it("should both overwrite values identically", async () => {
      await store.set("overwrite", "v1");
      await memStore.set("overwrite", "v1");
      await store.set("overwrite", "v2");
      await memStore.set("overwrite", "v2");

      expect(await store.get("overwrite")).toBe(await memStore.get("overwrite"));
    });

    it("should both return the same result for increment on new key", async () => {
      const sqlResult = await store.increment("parity-counter", 7);
      const memResult = await memStore.increment("parity-counter", 7);
      expect(sqlResult).toBe(memResult);
    });

    it("should both return the same result for sequential increments", async () => {
      await store.increment("seq-counter", 3);
      await memStore.increment("seq-counter", 3);
      const sqlResult = await store.increment("seq-counter", 5);
      const memResult = await memStore.increment("seq-counter", 5);
      expect(sqlResult).toBe(memResult);
    });

    it("should both return empty array for getRecent on non-existent list", async () => {
      const sqlRecent = await store.getRecent("no-list", 10);
      const memRecent = await memStore.getRecent("no-list", 10);
      expect(sqlRecent).toEqual(memRecent);
    });

    it("should both return entries in the same order after appends", async () => {
      const entries = ["first", "second", "third"];
      for (const e of entries) {
        await store.append("parity-list", e);
        await memStore.append("parity-list", e);
      }

      const sqlRecent = await store.getRecent("parity-list", 10);
      const memRecent = await memStore.getRecent("parity-list", 10);
      expect(sqlRecent).toEqual(memRecent);
    });

    it("should both return empty array for getRecent with count 0", async () => {
      await store.append("list-zero", "val");
      await memStore.append("list-zero", "val");

      expect(await store.getRecent("list-zero", 0)).toEqual(await memStore.getRecent("list-zero", 0));
    });

    it("should both return empty array for getRecent with negative count", async () => {
      await store.append("list-neg", "val");
      await memStore.append("list-neg", "val");

      expect(await store.getRecent("list-neg", -1)).toEqual(await memStore.getRecent("list-neg", -1));
    });

    it("should both handle increment of non-numeric existing value", async () => {
      await store.set("nan-key", "not-a-number");
      await memStore.set("nan-key", "not-a-number");

      const sqlResult = await store.increment("nan-key", 10);
      const memResult = await memStore.increment("nan-key", 10);
      expect(sqlResult).toBe(memResult);
    });

    it("should both expire values after TTL", async () => {
      await store.set("ttl-parity", "val", 0.001);
      await memStore.set("ttl-parity", "val", 0.001);
      await new Promise((r) => setTimeout(r, 10));

      expect(await store.get("ttl-parity")).toEqual(await memStore.get("ttl-parity"));
    });
  });
});
