import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../../../src/stores/memory.js";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
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
      // Wait for expiry
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
  });

  describe("TTL edge cases", () => {
    it("should not set TTL when ttlSeconds is zero", async () => {
      await store.set("key1", "value1", 0);
      await new Promise((r) => setTimeout(r, 10));
      // TTL of 0 should not expire the key (guard: ttlSeconds > 0)
      expect(await store.get("key1")).toBe("value1");
    });

    it("should not set TTL when ttlSeconds is negative", async () => {
      await store.set("key1", "value1", -5);
      await new Promise((r) => setTimeout(r, 10));
      // Negative TTL should not set expiration
      expect(await store.get("key1")).toBe("value1");
    });

    it("should lazily delete expired keys on get", async () => {
      await store.set("key1", "value1", 0.001); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      // First get should remove the key
      expect(await store.get("key1")).toBeNull();
      // Subsequent get should also return null
      expect(await store.get("key1")).toBeNull();
    });

    it("should return value just before TTL expires", async () => {
      await store.set("key1", "value1", 10); // 10 seconds TTL
      // Should still be available immediately
      expect(await store.get("key1")).toBe("value1");
    });

    it("should overwrite TTL when re-setting with new TTL", async () => {
      await store.set("key1", "value1", 0.001); // 1ms TTL
      await store.set("key1", "value2"); // no TTL = permanent
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("key1")).toBe("value2");
    });
  });

  describe("increment edge cases", () => {
    it("should handle increment by zero", async () => {
      await store.increment("counter", 5);
      const result = await store.increment("counter", 0);
      expect(result).toBe(5);
    });

    it("should handle first increment by zero (creates key at 0)", async () => {
      const result = await store.increment("counter", 0);
      expect(result).toBe(0);
    });

    it("should handle very large increments", async () => {
      const result = await store.increment("counter", Number.MAX_SAFE_INTEGER);
      expect(result).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should handle multiple sequential increments", async () => {
      for (let i = 1; i <= 10; i++) {
        await store.increment("counter", 1);
      }
      const value = await store.get("counter");
      expect(parseFloat(value!)).toBe(10);
    });

    it("should preserve TTL on increment of key with TTL", async () => {
      await store.set("counter", "5", 10); // 10-second TTL
      const result = await store.increment("counter", 3);
      expect(result).toBe(8);
      // The incremented value should still be accessible
      expect(await store.get("counter")).toBe("8");
    });

    it("should handle increment of expired key (treats as new key)", async () => {
      await store.set("counter", "100", 0.001); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      // Key has expired, increment should start from 0
      const result = await store.increment("counter", 5);
      expect(result).toBe(5);
    });

    it("should handle increment with non-numeric existing value", async () => {
      await store.set("key", "not-a-number");
      // parseFloat("not-a-number") returns NaN, which is treated as 0
      const result = await store.increment("key", 5);
      // Non-numeric values are treated as 0, so 0 + 5 = 5
      expect(result).toBe(5);
    });
  });

  describe("append/getRecent edge cases", () => {
    it("should return empty array when count is 0", async () => {
      await store.append("list", "entry1");
      const recent = await store.getRecent("list", 0);
      // count <= 0 now returns empty array (early guard)
      expect(recent).toEqual([]);
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

  describe("key isolation", () => {
    it("should keep key-value store and list store independent", async () => {
      await store.set("mykey", "myvalue");
      await store.append("mykey", "listvalue");

      // Key-value should not be affected by list operations
      expect(await store.get("mykey")).toBe("myvalue");
      // List should not be affected by key-value operations
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

    it("should clear both key-value and list data", async () => {
      await store.set("k1", "v1");
      await store.set("k2", "v2");
      await store.append("l1", "e1");
      await store.append("l2", "e2");
      store.clear();

      expect(await store.get("k1")).toBeNull();
      expect(await store.get("k2")).toBeNull();
      expect(await store.getRecent("l1", 10)).toEqual([]);
      expect(await store.getRecent("l2", 10)).toEqual([]);
    });
  });
});
