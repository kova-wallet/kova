import { describe, it, expect, beforeEach, vi } from "vitest";
import Redis from "ioredis";
import { RedisStore } from "../../../src/stores/redis.js";

/**
 * RedisStore tests using an in-memory mock of ioredis.
 *
 * This mock simulates Redis behavior (GET/SET/NX/PX/INCRBYFLOAT/RPUSH/LRANGE/LTRIM/DEL)
 * so tests run without a Redis server. Integration tests against a real Redis
 * instance should be added separately for CI environments with Redis available.
 */

// ---------------------------------------------------------------------------
// Minimal ioredis mock that simulates Redis in-memory
// ---------------------------------------------------------------------------
function createRedisMock() {
  const kv = new Map<string, { value: string; expiresAt?: number }>();
  const lists = new Map<string, string[]>();

  function isExpired(key: string): boolean {
    const entry = kv.get(key);
    if (entry?.expiresAt && Date.now() > entry.expiresAt) {
      kv.delete(key);
      return true;
    }
    return false;
  }

  // Pipeline accumulator for batched commands
  function createPipeline() {
    const commands: Array<() => unknown> = [];
    const pipeline = {
      rpush(key: string, value: string) {
        commands.push(() => {
          const list = lists.get(key) ?? [];
          list.push(value);
          lists.set(key, list);
          return list.length;
        });
        return pipeline;
      },
      ltrim(key: string, start: number, stop: number) {
        commands.push(() => {
          const list = lists.get(key);
          if (!list) return;
          // Normalize negative indices
          const len = list.length;
          const s = start < 0 ? Math.max(len + start, 0) : start;
          const e = stop < 0 ? len + stop : stop;
          const trimmed = list.slice(s, e + 1);
          lists.set(key, trimmed);
        });
        return pipeline;
      },
      async exec() {
        return commands.map((cmd) => [null, cmd()]);
      },
    };
    return pipeline;
  }

  const mock = {
    async get(key: string): Promise<string | null> {
      isExpired(key);
      return kv.get(key)?.value ?? null;
    },

    async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
      let ttlMs: number | undefined;
      let nx = false;
      let keepTtl = false;

      for (let i = 0; i < args.length; i++) {
        const arg = String(args[i]).toUpperCase();
        if (arg === "PX") {
          ttlMs = Number(args[++i]);
        } else if (arg === "NX") {
          nx = true;
        } else if (arg === "KEEPTTL") {
          keepTtl = true;
        }
      }

      if (nx) {
        isExpired(key);
        if (kv.has(key)) return null;
      }

      const existingExpiry = keepTtl ? kv.get(key)?.expiresAt : undefined;
      const entry: { value: string; expiresAt?: number } = { value };
      if (keepTtl && existingExpiry) {
        entry.expiresAt = existingExpiry;
      } else if (ttlMs !== undefined) {
        entry.expiresAt = Date.now() + ttlMs;
      }
      kv.set(key, entry);
      return "OK";
    },

    async incrbyfloat(key: string, amount: number): Promise<string> {
      isExpired(key);
      const existing = kv.get(key);
      const current = existing ? parseFloat(existing.value) : 0;
      const newVal = current + amount;
      const entry: { value: string; expiresAt?: number } = { value: String(newVal) };
      if (existing?.expiresAt) {
        entry.expiresAt = existing.expiresAt;
      }
      kv.set(key, entry);
      return String(newVal);
    },

    async eval(_script: string, numKeys: number, ...args: string[]): Promise<string | [string, string, string]> {
      // CRIT-1 fix: Updated mock to match the new atomic Lua script that takes
      // 2 KEYS (counter key + HMAC key) and returns [newValue, oldValue, oldHmac].
      const key = args[0]!;
      const hmacKey = numKeys >= 2 ? args[1]! : undefined;
      const amount = args[numKeys]!;
      // Simulate the Lua script: GET old value+HMAC, INCRBYFLOAT + round + clamp to 0
      isExpired(key);
      const existing = kv.get(key);
      const oldValue = existing ? existing.value : "";
      const oldHmac = hmacKey ? (kv.get(hmacKey)?.value ?? "") : "";
      const current = existing ? parseFloat(existing.value) : 0;
      const newVal = Math.max(0, current + parseFloat(amount));
      const rounded = parseFloat(newVal.toFixed(10)).toString();
      const entry: { value: string; expiresAt?: number } = { value: rounded };
      if (existing?.expiresAt) {
        entry.expiresAt = existing.expiresAt;
      }
      kv.set(key, entry);
      return [rounded, oldValue, oldHmac];
    },

    async rpush(key: string, value: string): Promise<number> {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    },

    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      return list.slice(s, e + 1);
    },

    async ltrim(key: string, start: number, stop: number): Promise<void> {
      const list = lists.get(key);
      if (!list) return;
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      lists.set(key, list.slice(s, e + 1));
    },

    async del(key: string): Promise<number> {
      const existed = kv.has(key) || lists.has(key);
      kv.delete(key);
      lists.delete(key);
      return existed ? 1 : 0;
    },

    pipeline: createPipeline,

    async quit(): Promise<void> {
      // no-op
    },

    on(_event: string, _handler: (...args: unknown[]) => void): void {
      // no-op for mock
    },

    // Expose internals for test assertions
    _kv: kv,
    _lists: lists,
  };

  return mock;
}

describe("RedisStore", () => {
  let store: RedisStore;
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    redisMock = createRedisMock();
    store = new RedisStore({ client: redisMock as unknown as Redis, requireHmacKey: false });
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

  describe("setIfNotExists", () => {
    it("should set value when key does not exist", async () => {
      const result = await store.setIfNotExists("key1", "value1");
      expect(result).toBe(true);
      expect(await store.get("key1")).toBe("value1");
    });

    it("should not overwrite existing key", async () => {
      await store.set("key1", "value1");
      const result = await store.setIfNotExists("key1", "value2");
      expect(result).toBe(false);
      expect(await store.get("key1")).toBe("value1");
    });

    it("should set with TTL when key does not exist", async () => {
      const result = await store.setIfNotExists("key1", "value1", 0.001);
      expect(result).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("key1")).toBeNull();
    });

    it("should set value when existing key has expired", async () => {
      await store.set("key1", "value1", 0.001);
      await new Promise((r) => setTimeout(r, 10));
      const result = await store.setIfNotExists("key1", "value2");
      expect(result).toBe(true);
      expect(await store.get("key1")).toBe("value2");
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

    it("should clamp negative results to zero", async () => {
      await store.increment("counter", 5);
      const result = await store.increment("counter", -10);
      expect(result).toBe(0);
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

    it("should reject non-finite amounts", async () => {
      await expect(store.increment("counter", NaN)).rejects.toThrow("finite number");
      await expect(store.increment("counter", Infinity)).rejects.toThrow("finite number");
      await expect(store.increment("counter", -Infinity)).rejects.toThrow("finite number");
    });

    it("should handle multiple sequential increments", async () => {
      for (let i = 1; i <= 10; i++) {
        await store.increment("counter", 1);
      }
      const value = await store.get("counter");
      expect(parseFloat(value!)).toBe(10);
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
      const recent = await store.getRecent("list", 0);
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

  describe("clearList", () => {
    it("should clear all entries in a list", async () => {
      await store.append("list", "entry1");
      await store.append("list", "entry2");
      await store.clearList("list");
      expect(await store.getRecent("list", 10)).toEqual([]);
    });

    it("should not affect other lists", async () => {
      await store.append("list1", "a");
      await store.append("list2", "b");
      await store.clearList("list1");
      expect(await store.getRecent("list1", 10)).toEqual([]);
      expect(await store.getRecent("list2", 10)).toEqual(["b"]);
    });

    it("should not throw when clearing non-existent list", async () => {
      await expect(store.clearList("nonexistent")).resolves.not.toThrow();
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

  describe("key prefix", () => {
    it("should apply keyPrefix to all KV operations", async () => {
      const prefixedStore = new RedisStore({
        client: redisMock as unknown as Redis,
        keyPrefix: "app:",
        requireHmacKey: false,
      });
      await prefixedStore.set("key1", "value1");
      // Verify the key in the underlying mock has the prefix
      expect(redisMock._kv.has("app:key1")).toBe(true);
      expect(await prefixedStore.get("key1")).toBe("value1");
    });

    it("should apply keyPrefix to list operations", async () => {
      const prefixedStore = new RedisStore({
        client: redisMock as unknown as Redis,
        keyPrefix: "app:",
        requireHmacKey: false,
      });
      await prefixedStore.append("log", "entry1");
      // List key should be prefixed with both keyPrefix and listPrefix
      expect(redisMock._lists.has("app:list:log")).toBe(true);
      expect(await prefixedStore.getRecent("log", 10)).toEqual(["entry1"]);
    });
  });

  describe("validation", () => {
    it("should reject keys exceeding max length", async () => {
      const longKey = "a".repeat(513);
      await expect(store.get(longKey)).rejects.toThrow("exceeds max length");
      await expect(store.set(longKey, "val")).rejects.toThrow("exceeds max length");
    });

    it("should reject keys with null bytes", async () => {
      await expect(store.get("key\0bad")).rejects.toThrow("null bytes");
    });

    it("should reject values exceeding max length", async () => {
      const longValue = "x".repeat(1_000_001);
      await expect(store.set("key", longValue)).rejects.toThrow("exceeds maximum");
      await expect(store.append("key", longValue)).rejects.toThrow("exceeds maximum");
    });

    it("should throw on zero ttlSeconds (MED-08)", async () => {
      await expect(store.set("k", "v", 0)).rejects.toThrow("positive finite number");
    });

    it("should throw on negative ttlSeconds (MED-08)", async () => {
      await expect(store.set("k", "v", -5)).rejects.toThrow("positive finite number");
    });

    it("should throw on NaN ttlSeconds", async () => {
      await expect(store.set("k", "v", NaN)).rejects.toThrow("positive finite number");
    });

    it("should throw on Infinity ttlSeconds", async () => {
      await expect(store.set("k", "v", Infinity)).rejects.toThrow("positive finite number");
    });
  });

  describe("disconnect", () => {
    it("should call quit when store owns the connection", async () => {
      // Create a store that thinks it owns the connection by using a mock
      // that was provided via client — ownsConnection = false, so quit is NOT called
      const quitSpy = vi.spyOn(redisMock, "quit");
      await store.disconnect();
      // client was passed in config, so ownsConnection = false
      expect(quitSpy).not.toHaveBeenCalled();
    });
  });
});
