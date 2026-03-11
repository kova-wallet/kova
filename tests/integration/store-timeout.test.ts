/**
 * Integration test: StoreWithTimeout — a Store wrapper that enforces per-operation deadlines.
 *
 * src/stores/timeout.ts does not exist yet in the codebase. This test file acts as
 * a specification and scaffold: it defines the expected interface and behaviour, and
 * implements the wrapper inline so tests can run today. When the real module ships,
 * the inline implementation below should be deleted and the named import should be
 * updated to point at the production path.
 *
 * The tests verify:
 *  1. All Store operations complete normally when the underlying store is fast.
 *  2. Each Store operation throws StoreTimeoutError when the underlying store hangs.
 *  3. The timeout duration is configurable at construction time.
 */

import { describe, it, expect } from "vitest";
import { MemoryStore } from "../../src/stores/memory.js";
import type { Store } from "../../src/stores/interface.js";

// ---------------------------------------------------------------------------
// StoreTimeoutError — the error thrown when an operation exceeds its deadline.
// ---------------------------------------------------------------------------

export class StoreTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(
      `Store operation "${operation}" timed out after ${timeoutMs}ms. ` +
      `The underlying store may be hung or unreachable.`,
    );
    this.name = "StoreTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// StoreWithTimeout — specification-level implementation.
//
// NOTE: When src/stores/timeout.ts is created, replace this class body with
//   export { StoreWithTimeout } from "../../src/stores/timeout.js";
// ---------------------------------------------------------------------------

export class StoreWithTimeout implements Store {
  private readonly inner: Store;
  private readonly timeoutMs: number;

  /**
   * @param inner     The underlying store to delegate all operations to.
   * @param timeoutMs Maximum milliseconds to wait for each operation. Default: 5000.
   */
  constructor(inner: Store, timeoutMs = 5_000) {
    if (timeoutMs <= 0) {
      throw new RangeError(`StoreWithTimeout: timeoutMs must be > 0, got ${timeoutMs}`);
    }
    this.inner = inner;
    this.timeoutMs = timeoutMs;
  }

  private withTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StoreTimeoutError(operation, this.timeoutMs));
      }, this.timeoutMs);

      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  get(key: string): Promise<string | null> {
    return this.withTimeout("get", this.inner.get(key));
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.withTimeout("set", this.inner.set(key, value, ttlSeconds));
  }

  setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    return this.withTimeout("setIfNotExists", this.inner.setIfNotExists(key, value, ttlSeconds));
  }

  increment(key: string, amount: number): Promise<number> {
    return this.withTimeout("increment", this.inner.increment(key, amount));
  }

  append(key: string, value: string): Promise<void> {
    return this.withTimeout("append", this.inner.append(key, value));
  }

  getRecent(key: string, count: number): Promise<string[]> {
    return this.withTimeout("getRecent", this.inner.getRecent(key, count));
  }

  clearList(key: string): Promise<void> {
    return this.withTimeout("clearList", this.inner.clearList(key));
  }
}

// ---------------------------------------------------------------------------
// A HangingStore — every operation returns a promise that never resolves,
// simulating an unresponsive backend (e.g., SQLite lock contention, network hang).
// ---------------------------------------------------------------------------

function makeHangingStore(): Store {
  const never = (): Promise<never> => new Promise(() => { /* never resolves */ });
  return {
    get: never,
    set: never,
    setIfNotExists: never,
    increment: never,
    append: never,
    getRecent: never,
    clearList: never,
  };
}

// ---------------------------------------------------------------------------
// Tests — normal operation (fast store)
// ---------------------------------------------------------------------------

describe("StoreWithTimeout — normal operation (fast underlying store)", () => {
  it("get() resolves and returns the stored value", async () => {
    const inner = new MemoryStore();
    await inner.set("k", "v");
    const wrapped = new StoreWithTimeout(inner, 1000);

    expect(await wrapped.get("k")).toBe("v");
    expect(await wrapped.get("missing")).toBeNull();
  });

  it("set() persists a value readable via get()", async () => {
    const inner = new MemoryStore();
    const wrapped = new StoreWithTimeout(inner, 1000);

    await wrapped.set("greeting", "hello");
    expect(await inner.get("greeting")).toBe("hello");
  });

  it("setIfNotExists() returns true on first write, false on second", async () => {
    const inner = new MemoryStore();
    const wrapped = new StoreWithTimeout(inner, 1000);

    expect(await wrapped.setIfNotExists("once", "first", 3600)).toBe(true);
    expect(await wrapped.setIfNotExists("once", "second", 3600)).toBe(false);
    // Value must remain "first".
    expect(await inner.get("once")).toBe("first");
  });

  it("increment() delegates correctly", async () => {
    const inner = new MemoryStore();
    const wrapped = new StoreWithTimeout(inner, 1000);

    expect(await wrapped.increment("counter", 5)).toBe(5);
    expect(await wrapped.increment("counter", 3)).toBe(8);
    expect(await wrapped.increment("counter", -2)).toBe(6);
  });

  it("append() and getRecent() delegate correctly", async () => {
    const inner = new MemoryStore();
    const wrapped = new StoreWithTimeout(inner, 1000);

    await wrapped.append("log", "first");
    await wrapped.append("log", "second");
    await wrapped.append("log", "third");

    const entries = await wrapped.getRecent("log", 10);
    // getRecent returns newest-first.
    expect(entries).toEqual(["third", "second", "first"]);
  });

  it("clearList() removes all list entries", async () => {
    const inner = new MemoryStore();
    const wrapped = new StoreWithTimeout(inner, 1000);

    await wrapped.append("log", "a");
    await wrapped.append("log", "b");
    await wrapped.clearList("log");

    expect(await wrapped.getRecent("log", 100)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — timeout behaviour (hanging store)
// ---------------------------------------------------------------------------

describe("StoreWithTimeout — timeout on a hanging store", () => {
  const SHORT_TIMEOUT_MS = 50; // 50 ms — fast enough for test runs

  it("get() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.get("any")).rejects.toThrow(StoreTimeoutError);
    await expect(wrapped.get("any")).rejects.toThrow(`"get" timed out after ${SHORT_TIMEOUT_MS}ms`);
  });

  it("set() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.set("k", "v")).rejects.toThrow(StoreTimeoutError);
    await expect(wrapped.set("k", "v")).rejects.toThrow(`"set" timed out after ${SHORT_TIMEOUT_MS}ms`);
  });

  it("setIfNotExists() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.setIfNotExists("k", "v")).rejects.toThrow(StoreTimeoutError);
  });

  it("increment() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.increment("counter", 1)).rejects.toThrow(StoreTimeoutError);
  });

  it("append() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.append("log", "entry")).rejects.toThrow(StoreTimeoutError);
  });

  it("getRecent() throws StoreTimeoutError when the store hangs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    await expect(wrapped.getRecent("log", 10)).rejects.toThrow(StoreTimeoutError);
  });

  it("StoreTimeoutError exposes operation name and timeoutMs", async () => {
    const wrapped = new StoreWithTimeout(makeHangingStore(), SHORT_TIMEOUT_MS);

    try {
      await wrapped.get("k");
      expect.fail("Expected StoreTimeoutError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreTimeoutError);
      const timeoutErr = err as StoreTimeoutError;
      expect(timeoutErr.operation).toBe("get");
      expect(timeoutErr.timeoutMs).toBe(SHORT_TIMEOUT_MS);
      expect(timeoutErr.name).toBe("StoreTimeoutError");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — configurable timeout
// ---------------------------------------------------------------------------

describe("StoreWithTimeout — configurable timeout duration", () => {
  it("rejects a zero timeout at construction", () => {
    expect(() => new StoreWithTimeout(new MemoryStore(), 0)).toThrow(RangeError);
    expect(() => new StoreWithTimeout(new MemoryStore(), -100)).toThrow(RangeError);
  });

  it("uses the default timeout of 5000 ms when not specified", async () => {
    const inner = new MemoryStore();
    // With a fast store and default timeout, operations should complete normally.
    const wrapped = new StoreWithTimeout(inner);
    await wrapped.set("key", "val");
    expect(await wrapped.get("key")).toBe("val");
  });

  it("a fast store always completes before a short timeout", async () => {
    const inner = new MemoryStore();
    // Even 1 ms timeout — MemoryStore is sync-backed so it resolves immediately.
    const wrapped = new StoreWithTimeout(inner, 1);

    // May occasionally flake under heavy load, but in practice MemoryStore resolves
    // in the same microtask so a 1 ms timer will not fire first.
    await wrapped.set("k", "v");
    expect(await wrapped.get("k")).toBe("v");
  });

  it("a larger timeout allows slow but finite operations to succeed", async () => {
    // Create a store that adds a 10 ms delay to every operation.
    const inner = new MemoryStore();
    const slowStore: Store = {
      get: (k) => new Promise((resolve) => setTimeout(() => resolve(inner.get(k)), 10)),
      set: (k, v, ttl) => new Promise((resolve, reject) => setTimeout(() => inner.set(k, v, ttl).then(resolve, reject), 10)),
      setIfNotExists: (k, v, ttl) => new Promise((resolve, reject) => setTimeout(() => inner.setIfNotExists(k, v, ttl).then(resolve, reject), 10)),
      increment: (k, a) => new Promise((resolve, reject) => setTimeout(() => inner.increment(k, a).then(resolve, reject), 10)),
      append: (k, v) => new Promise((resolve, reject) => setTimeout(() => inner.append(k, v).then(resolve, reject), 10)),
      getRecent: (k, c) => new Promise((resolve, reject) => setTimeout(() => inner.getRecent(k, c).then(resolve, reject), 10)),
    };

    // With a 200 ms timeout the 10 ms delay is fine.
    const wrapped = new StoreWithTimeout(slowStore, 200);
    await wrapped.set("delayed", "value");
    expect(await wrapped.get("delayed")).toBe("value");
  });

  it("a smaller timeout than the store delay causes StoreTimeoutError", async () => {
    // Create a store with a 100 ms delay.
    const slowStore: Store = {
      get: () => new Promise((resolve) => setTimeout(() => resolve(null), 100)),
      set: () => new Promise((resolve) => setTimeout(() => resolve(), 100)),
      setIfNotExists: () => new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      increment: () => new Promise((resolve) => setTimeout(() => resolve(0), 100)),
      append: () => new Promise((resolve) => setTimeout(() => resolve(), 100)),
      getRecent: () => new Promise((resolve) => setTimeout(() => resolve([]), 100)),
    };

    // With a 30 ms timeout the 100 ms delay causes a timeout.
    const wrapped = new StoreWithTimeout(slowStore, 30);
    await expect(wrapped.get("k")).rejects.toThrow(StoreTimeoutError);
  });
});
