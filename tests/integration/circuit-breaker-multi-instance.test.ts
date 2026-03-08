/**
 * Integration test: CircuitBreaker multi-instance detection.
 *
 * The CircuitBreaker comment block (src/core/circuit-breaker.ts lines 11-51) documents
 * a SINGLE-INSTANCE REQUIREMENT: running two CircuitBreaker instances against the same
 * store breaks security guarantees (serialisation, idempotency, spending limits, etc.).
 *
 * ============================================================================
 * ACTUAL BEHAVIOUR OF initialize() (CRIT-04 fix applied):
 * ============================================================================
 *
 * Multi-instance detection uses a flag pattern so the throw is NOT swallowed:
 *
 *   let multiInstanceDetected = false;
 *   try {
 *     const claimed = await store.setIfNotExists(INSTANCE_KEY, instanceId, TTL);
 *     if (!claimed) {
 *       multiInstanceDetected = true;
 *       if (!config.failOnMultiInstance) {
 *         process.emitWarning("Multiple instances detected...",
 *           { code: "KOVA_MULTI_INSTANCE_WARNING" });               // WARNS
 *       }
 *     }
 *   } catch {
 *     process.emitWarning("Failed to perform multi-instance detection",
 *       { code: "KOVA_INTERNAL_WARNING" });                         // WARNS
 *   }
 *   // AFTER the try-catch — throw propagates correctly
 *   if (multiInstanceDetected && config.failOnMultiInstance) {
 *     throw new Error("[KOVA CRITICAL] Multiple instances...");      // THROWS
 *   }
 *
 * Result:
 *  - failOnMultiInstance: true  → initialize() REJECTS with "[KOVA CRITICAL]" error
 *  - failOnMultiInstance: false → initialize() RESOLVES and emits KOVA_MULTI_INSTANCE_WARNING
 * ============================================================================
 */

import { describe, it, expect } from "vitest";
import { MemoryStore } from "../../src/stores/memory.js";
import { CircuitBreaker } from "../../src/core/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBreaker(
  store: MemoryStore,
  overrides?: Partial<ConstructorParameters<typeof CircuitBreaker>[1]>,
): CircuitBreaker {
  return new CircuitBreaker(store, {
    threshold: 3,
    cooldownMs: 0,
    ...overrides,
  });
}

/**
 * Collect process warnings emitted during and immediately after `fn`.
 * Adds a 20ms flush to let the event loop deliver any queued warning events.
 *
 * The `warning` event fires with a `Warning` object (an Error subclass).
 * We extract the `.message` and the `.code` property (added by { code: "..." } options).
 */
async function captureWarnings(
  fn: () => Promise<void>,
): Promise<Array<{ message: string; code: string | undefined }>> {
  const captured: Array<{ message: string; code: string | undefined }> = [];

  const listener = (warning: Error & { code?: string }) => {
    captured.push({ message: warning.message ?? "", code: warning.code });
  };

  process.on("warning", listener);
  try {
    await fn();
    // Flush the event loop so queued warning events are delivered.
    await new Promise<void>((r) => setTimeout(r, 20));
  } finally {
    process.removeListener("warning", listener);
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Tests — single-instance happy path
// ---------------------------------------------------------------------------

describe("CircuitBreaker — single instance", () => {
  it("initialises without throwing and without any multi-instance warning", async () => {
    const store = new MemoryStore();
    const breaker = makeBreaker(store);

    const warnings = await captureWarnings(async () => {
      await breaker.initialize();
    });

    const relevant = warnings.filter(
      (w) =>
        w.code === "KOVA_MULTI_INSTANCE_WARNING" ||
        w.code === "KOVA_INTERNAL_WARNING" ||
        w.message.includes("Multiple instances") ||
        w.message.includes("multi-instance"),
    );
    expect(relevant).toHaveLength(0);

    breaker.destroy();
    store.stopGc();
  });

  it("calling initialize() twice on the same instance is a no-op", async () => {
    const store = new MemoryStore();
    const breaker = makeBreaker(store);

    await breaker.initialize();
    await expect(breaker.initialize()).resolves.not.toThrow();

    breaker.destroy();
    store.stopGc();
  });
});

// ---------------------------------------------------------------------------
// Tests — multi-instance detection with failOnMultiInstance: true (default)
// ---------------------------------------------------------------------------

describe("CircuitBreaker — failOnMultiInstance: true (default)", () => {
  it("second initialize() rejects with [KOVA CRITICAL] error (CRIT-04 fix)", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: true });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: true });

    await breaker1.initialize();

    // CRIT-04 fix: failOnMultiInstance: true now REJECTS rather than swallowing the error.
    await expect(breaker2.initialize()).rejects.toThrow("[KOVA CRITICAL]");

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });

  it("third instance also rejects with [KOVA CRITICAL] error", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: true });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: true });
    const breaker3 = makeBreaker(store, { failOnMultiInstance: true });

    await breaker1.initialize();

    await expect(breaker2.initialize()).rejects.toThrow("[KOVA CRITICAL]");
    await expect(breaker3.initialize()).rejects.toThrow("[KOVA CRITICAL]");

    breaker1.destroy();
    breaker2.destroy();
    breaker3.destroy();
    store.stopGc();
  });
});

// ---------------------------------------------------------------------------
// Tests — failOnMultiInstance: false — warning not error
// ---------------------------------------------------------------------------

describe("CircuitBreaker — failOnMultiInstance: false", () => {
  it("second initialize() resolves and emits KOVA_MULTI_INSTANCE_WARNING", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: false });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: false });

    await breaker1.initialize();

    const warnings = await captureWarnings(async () => {
      await expect(breaker2.initialize()).resolves.not.toThrow();
    });

    const multiInstanceWarning = warnings.find(
      (w) =>
        w.code === "KOVA_MULTI_INSTANCE_WARNING" ||
        w.message.includes("Multiple instances detected"),
    );
    expect(multiInstanceWarning).toBeDefined();

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });

  it("both instances can call isOpen() without error when coexisting", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: false, threshold: 5 });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: false, threshold: 5 });

    await breaker1.initialize();
    await breaker2.initialize();

    const intent = {
      type: "transfer" as const,
      chain: "solana",
      params: { to: "recipient", amount: "1", token: "SOL" },
    };

    expect(typeof await breaker1.isOpen(intent)).toBe("boolean");
    expect(typeof await breaker2.isOpen(intent)).toBe("boolean");

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });
});

// ---------------------------------------------------------------------------
// Tests — mixed configuration
// ---------------------------------------------------------------------------

describe("CircuitBreaker — mixed failOnMultiInstance configuration", () => {
  it("first lenient + second strict: second rejects with [KOVA CRITICAL] (CRIT-04 fix)", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: false });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: true });

    await breaker1.initialize();

    // CRIT-04 fix: strict second instance correctly throws rather than swallowing the error.
    await expect(breaker2.initialize()).rejects.toThrow("[KOVA CRITICAL]");

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });

  it("first strict + second lenient: second emits KOVA_MULTI_INSTANCE_WARNING", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: true });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: false });

    await breaker1.initialize();

    const warnings = await captureWarnings(async () => {
      await expect(breaker2.initialize()).resolves.not.toThrow();
    });

    // Lenient breaker emits KOVA_MULTI_INSTANCE_WARNING directly (no throw).
    expect(
      warnings.some(
        (w) =>
          w.code === "KOVA_MULTI_INSTANCE_WARNING" ||
          w.message.includes("Multiple instances"),
      ),
    ).toBe(true);

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });
});

// ---------------------------------------------------------------------------
// Tests — separate stores — no false positives
// ---------------------------------------------------------------------------

describe("CircuitBreaker — separate stores are independent", () => {
  it("two instances on different stores emit no multi-instance warnings", async () => {
    const store1 = new MemoryStore();
    const store2 = new MemoryStore();

    const breaker1 = makeBreaker(store1);
    const breaker2 = makeBreaker(store2);

    const warnings = await captureWarnings(async () => {
      await breaker1.initialize();
      await breaker2.initialize();
    });

    const relevant = warnings.filter(
      (w) =>
        w.code === "KOVA_MULTI_INSTANCE_WARNING" ||
        w.code === "KOVA_INTERNAL_WARNING" ||
        w.message.includes("Multiple instances") ||
        w.message.includes("Failed to perform multi-instance"),
    );
    expect(relevant).toHaveLength(0);

    breaker1.destroy();
    breaker2.destroy();
    store1.stopGc();
    store2.stopGc();
  });
});

// ---------------------------------------------------------------------------
// Tests — circuit breaker functional behaviour
// ---------------------------------------------------------------------------

describe("CircuitBreaker — functional check/recordOutcome", () => {
  it("circuit starts closed (isOpen returns false)", async () => {
    const store = new MemoryStore();
    const breaker = makeBreaker(store, { threshold: 3, cooldownMs: 100 });
    await breaker.initialize();

    const intent = {
      type: "transfer" as const,
      chain: "solana",
      params: { to: "r", amount: "1", token: "SOL" },
    };

    expect(await breaker.isOpen(intent)).toBe(false);

    breaker.destroy();
    store.stopGc();
  });

  it("circuit opens after threshold consecutive denials", async () => {
    const store = new MemoryStore();
    const breaker = makeBreaker(store, { threshold: 3, cooldownMs: 100_000 });
    await breaker.initialize();

    const intent = {
      type: "transfer" as const,
      chain: "solana",
      params: { to: "r", amount: "1", token: "SOL" },
    };

    await breaker.recordOutcome("DENY");
    await breaker.recordOutcome("DENY");
    await breaker.recordOutcome("DENY");

    expect(await breaker.isOpen(intent)).toBe(true);

    breaker.destroy();
    store.stopGc();
  });

  it("allows isOpen() check without errors after multi-instance coexistence", async () => {
    const store = new MemoryStore();
    const breaker1 = makeBreaker(store, { failOnMultiInstance: false, threshold: 5 });
    const breaker2 = makeBreaker(store, { failOnMultiInstance: false, threshold: 5 });

    await breaker1.initialize();
    await breaker2.initialize();

    const intent = {
      type: "transfer" as const,
      chain: "solana",
      params: { to: "r", amount: "1", token: "SOL" },
    };

    expect(typeof await breaker1.isOpen(intent)).toBe("boolean");
    expect(typeof await breaker2.isOpen(intent)).toBe("boolean");

    breaker1.destroy();
    breaker2.destroy();
    store.stopGc();
  });
});
