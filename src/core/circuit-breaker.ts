/**
 * CircuitBreaker — Tracks consecutive policy denials and enters a cooldown
 * period after N denials to prevent runaway agent behavior.
 *
 * Operates at the wallet level (before policy evaluation) so it cannot be
 * bypassed by reconfiguring rules.
 *
 * Store key: circuit:state (MED-16 fix: atomic combined JSON state)
 *
 * ============================================================================
 * CRIT-02 — SINGLE-INSTANCE REQUIREMENT
 * ============================================================================
 * This CircuitBreaker is designed for SINGLE-INSTANCE deployments only.
 * Running multiple wallet processes against the same store backend WITHOUT
 * distributed locking breaks ALL of the following security guarantees:
 *   - Mutex serialization of transaction processing
 *   - Idempotency checks (concurrent duplicate submissions may both pass)
 *   - Spending limit enforcement (concurrent spends may exceed limits)
 *   - Rate limit enforcement (concurrent requests may exceed rate limits)
 *   - Circuit breaker threshold accuracy (TOCTOU between check/record)
 *   - Audit log hash chain integrity (concurrent appends break ordering)
 *
 * At construction time, a multi-instance detection mechanism writes a unique
 * instance ID to the store. If another instance is detected, a CRITICAL
 * warning is logged. This is a best-effort detection — it does NOT prevent
 * multi-instance operation, only warns about it.
 *
 * For multi-instance deployments, you MUST implement one of:
 *   1. Distributed locking (e.g., Redis Redlock) around all wallet operations
 *   2. Request routing to ensure each wallet is handled by exactly one instance
 *   3. PrefixedStore with per-instance prefixes (degrades security isolation)
 * ============================================================================
 *
 * CRIT-10 LIMITATION — TOCTOU in multi-instance deployments:
 * The check() and recordOutcome() methods are NOT atomic. In a multi-instance
 * deployment (e.g., multiple wallet processes sharing a Redis-backed store),
 * a race condition exists between check() reading the cooldown state and
 * recordOutcome() incrementing the denial counter. Two concurrent requests
 * could both pass check() before either triggers the threshold, effectively
 * allowing more transactions than the threshold intends. This is inherent to
 * the two-step read-then-write pattern against a shared store.
 * RECOMMENDATION: For multi-instance deployments, use PrefixedStore with
 * per-instance prefixes, or implement store-level atomic check-and-increment
 * (e.g., Redis Lua scripts) to eliminate the TOCTOU window.
 *
 * MED-24 note: A single circuit breaker is shared across all agents and intent types.
 * A malicious agent can deliberately trigger denials to open the circuit breaker,
 * blocking legitimate agents. For multi-agent deployments, use PrefixedStore with
 * per-agent prefixes to isolate circuit breaker state per agent.
 *
 * MED-27 note: All intent types (transfers, swaps, stakes) share one circuit breaker.
 * Five consecutive denied swaps will block transfers too. For per-intent-type isolation,
 * create separate CircuitBreaker instances with different store key prefixes.
 */

import { randomUUID } from "node:crypto";
import type { Store } from "../stores/interface.js";

/** CRIT-02: Key used to detect multiple instances sharing the same store */
const INSTANCE_KEY = "__kova_instance_id__";

/** CRIT-02: How often (in ms) to refresh the instance heartbeat */
const INSTANCE_HEARTBEAT_INTERVAL_MS = 15_000;

/** CRIT-02: TTL (in seconds) for the instance ID entry — must be > heartbeat interval */
const INSTANCE_TTL_SECONDS = 30;

/** Configuration for the circuit breaker */
export interface CircuitBreakerConfig {
  /** Number of consecutive denials before circuit opens. Must be >= 1. Default: 5 */
  threshold: number;
  /** Cooldown period in milliseconds. Must be >= 0. Default: 300_000 (5 min) */
  cooldownMs: number;
  /**
   * MED-T5-08 fix: Intent types to check in isOpen(). Defaults to common types
   * ["transfer", "swap", "stake", "custom"]. If your application defines additional
   * intent types, include them here so isOpen() checks their circuit breaker state.
   */
  intentTypes?: string[];
}

/** MED-T5-08 fix: Default intent types for isOpen() checks */
const DEFAULT_INTENT_TYPES = ["transfer", "swap", "stake", "custom"];

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  threshold: 5,
  cooldownMs: 300_000,
};

/**
 * MED-16 fix: Combined store key for atomic circuit breaker state.
 * Previously used two separate keys (circuit:denial_count, circuit:cooldown_until)
 * which created a non-atomic reset — a crash between the two writes could leave
 * inconsistent state. Now both values are stored as a single JSON object under
 * one key, so a single store.set() atomically updates the entire state.
 *
 * LOW-16 note: These keys are not namespaced per wallet instance. In multi-wallet
 * deployments sharing a store, use PrefixedStore to isolate circuit breaker state.
 */
const CIRCUIT_STATE_KEY = "circuit:state";

/** Legacy store keys — kept for backward compatibility during migration */
const LEGACY_DENIAL_COUNT_KEY = "circuit:denial_count";
const LEGACY_COOLDOWN_UNTIL_KEY = "circuit:cooldown_until";

/** Shape of the combined circuit breaker state */
interface CircuitBreakerState {
  denialCount: number;
  cooldownUntil: number; // 0 means no cooldown active
}

/**
 * CircuitBreaker — Tracks consecutive policy denials and enters a cooldown
 * period after N denials to prevent runaway agent behavior.
 *
 * Operates at the wallet level (before policy evaluation) so it cannot be
 * bypassed by reconfiguring rules. State is persisted via the Store interface.
 */
export class CircuitBreaker {
  private readonly store: Store;
  private readonly config: CircuitBreakerConfig;
  /** CRIT-02: Unique ID for this instance, used for multi-instance detection */
  private readonly instanceId: string;
  /** CRIT-02: Interval handle for heartbeat refresh; undefined until initialize() is called */
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  /** CRIT-02: Whether initialize() has been called */
  private initialized = false;

  constructor(store: Store, config?: Partial<CircuitBreakerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.instanceId = randomUUID();

    if (this.config.threshold < 1) {
      throw new Error("CircuitBreaker threshold must be at least 1");
    }
    if (this.config.cooldownMs < 0) {
      throw new Error("CircuitBreaker cooldownMs must be >= 0");
    }
    // S6-09 note: cooldownMs=0 means the circuit breaker triggers but resets immediately.
    // This is a valid "counting-only" configuration. For effective protection, use cooldownMs >= 1000.
  }

  /**
   * CRIT-02: Initialize multi-instance detection.
   * Must be called after construction to check for conflicting instances.
   * This is async because it interacts with the store.
   *
   * Writes a unique instance ID to the store with a short TTL. If another
   * instance's ID is already present, logs a critical warning. Starts a
   * periodic heartbeat to keep the instance ID alive.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Check for existing instance
    try {
      const existing = await this.store.get(INSTANCE_KEY);
      if (existing && existing !== this.instanceId) {
        console.error(
          "[KOVA CRITICAL] Multiple instances detected sharing the same store. " +
            "This breaks security guarantees including mutex serialization, idempotency, " +
            "spending limits, and audit hash chains. Use a single instance or implement " +
            "distributed locking. " +
            `(existing: ${existing.slice(0, 8)}..., this: ${this.instanceId.slice(0, 8)}...)`
        );
      }
      await this.store.set(INSTANCE_KEY, this.instanceId, INSTANCE_TTL_SECONDS);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[KOVA WARNING] Failed to perform multi-instance detection: ${message}`);
    }

    // Refresh instance ID periodically so the TTL doesn't expire while running
    this.heartbeatInterval = setInterval(() => {
      void this.store.set(INSTANCE_KEY, this.instanceId, INSTANCE_TTL_SECONDS).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[KOVA WARNING] Failed to refresh instance heartbeat: ${message}`);
      });
    }, INSTANCE_HEARTBEAT_INTERVAL_MS);

    // Ensure the interval doesn't prevent Node.js from exiting
    if (this.heartbeatInterval && typeof this.heartbeatInterval === "object" && "unref" in this.heartbeatInterval) {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * CRIT-02: Stop the heartbeat interval. Call this when shutting down
   * the circuit breaker to allow clean process exit.
   */
  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * CORE-011 fix: Resolve the store key for circuit breaker state.
   * When an intentType is provided, uses a per-intent-type key (e.g., "circuit:state:transfer")
   * to isolate circuit breaker state per intent type. Falls back to the global key when
   * no intentType is provided, preserving backward compatibility.
   *
   * H-07 fix: When an agentId is provided, uses a per-agent key (e.g., "circuit:state:agent:abc123")
   * to isolate circuit breaker state per agent. This prevents a single malicious agent from
   * triggering circuit breaker cooldown for all agents (cross-agent DoS).
   * When both agentId and intentType are provided, creates a compound key.
   */
  private stateKey(intentType?: string, agentId?: string): string {
    let key = CIRCUIT_STATE_KEY;
    if (agentId) {
      key = `${key}:agent:${agentId}`;
    }
    if (intentType) {
      key = `${key}:${intentType}`;
    }
    return key;
  }

  /**
   * Read the current circuit breaker state from the store.
   * Falls back to legacy keys for backward compatibility.
   * CORE-011: Accepts optional intentType for per-intent-type state isolation.
   * H-07: Accepts optional agentId for per-agent state isolation.
   */
  private async getState(intentType?: string, agentId?: string): Promise<CircuitBreakerState> {
    const raw = await this.store.get(this.stateKey(intentType, agentId));
    if (raw !== null && raw !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "denialCount" in parsed &&
          "cooldownUntil" in parsed &&
          typeof (parsed as CircuitBreakerState).denialCount === "number" &&
          typeof (parsed as CircuitBreakerState).cooldownUntil === "number"
        ) {
          return parsed as CircuitBreakerState;
        }
        // M-39: Parsed successfully but shape is invalid — fail-CLOSED.
        // Treat corrupted/unexpected shape as circuit open to deny transactions
        // rather than silently allowing them through.
        console.error(
          "[KOVA SECURITY] Circuit breaker state has unexpected shape — failing CLOSED (blocking). " +
            "This is a safety measure: corrupted state denies transactions rather than allowing them."
        );
        return { denialCount: Infinity, cooldownUntil: Infinity };
      } catch (err: unknown) {
        // M-39 fix: FAIL-CLOSED on corrupted/unparseable state.
        // Previously this fell through to the default (open/allow) state, meaning
        // corrupted state would silently disable the circuit breaker. Now we treat
        // parse failures as circuit-open (deny) to maintain safety invariants.
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(
          `[KOVA SECURITY] Circuit breaker state corrupted (${message}) — failing CLOSED (blocking). ` +
            "This is a safety measure: corrupted state denies transactions rather than allowing them."
        );
        return { denialCount: Infinity, cooldownUntil: Infinity };
      }
    }

    // Legacy migration: check old separate keys
    const legacyCount = await this.store.get(LEGACY_DENIAL_COUNT_KEY);
    const legacyCooldown = await this.store.get(LEGACY_COOLDOWN_UNTIL_KEY);
    if (legacyCount !== null || legacyCooldown !== null) {
      const state: CircuitBreakerState = {
        denialCount: legacyCount ? parseInt(legacyCount, 10) || 0 : 0,
        cooldownUntil: legacyCooldown ? parseInt(legacyCooldown, 10) || 0 : 0,
      };
      // Migrate to new combined key
      await this.setState(state);
      return state;
    }

    return { denialCount: 0, cooldownUntil: 0 };
  }

  /**
   * MED-16 fix: Atomically write the full circuit breaker state as a single JSON value.
   * This eliminates the non-atomic two-key write that could leave inconsistent state
   * if the process crashed between writes.
   * CORE-011: Accepts optional intentType for per-intent-type state isolation.
   * H-07: Accepts optional agentId for per-agent state isolation.
   */
  private async setState(state: CircuitBreakerState, intentType?: string, agentId?: string): Promise<void> {
    await this.store.set(this.stateKey(intentType, agentId), JSON.stringify(state));
  }

  /**
   * MED-20 fix: Clamp a timestamp to within 1 hour of Date.now() to prevent
   * drift-based manipulation of circuit breaker timing.
   *
   * LOW-T4-03 fix: Cross-reference — This 1-hour drift clamp is intentionally wider
   * than the 5-minute clamp in PolicyEngine.evaluate() (src/policy/engine.ts). The
   * circuit breaker uses a wider clamp because cooldown periods can be significantly
   * longer (default 5 minutes, configurable up to hours). A tight 5-minute clamp would
   * reject legitimate `now` values during long cooldown checks. The policy engine uses
   * a tighter 5-minute clamp because policy evaluation (spending limits, time windows)
   * is more sensitive to time manipulation and requires near-real-time accuracy.
   */
  private clampTime(now?: number): number {
    const realNow = Date.now();
    if (now === undefined) return realNow;
    const MAX_DRIFT_MS = 3_600_000; // 1 hour — see LOW-T4-03 for rationale vs engine's 5min
    if (!Number.isFinite(now) || Math.abs(now - realNow) > MAX_DRIFT_MS) {
      return realNow;
    }
    return now;
  }

  /**
   * Check whether the circuit breaker is currently blocking.
   * Returns null if OK, or a denial reason string if blocked.
   *
   * Automatically resets the circuit after the cooldown period expires.
   * MED-20 fix: now parameter is drift-clamped to within 1 hour of Date.now().
   * CORE-011: Accepts optional intentType for per-intent-type state isolation.
   * When provided, checks the circuit breaker state for that specific intent type.
   * Falls back to global state when not provided.
   * H-07: Accepts optional agentId for per-agent state isolation. When provided,
   * checks the circuit breaker state for that specific agent, preventing cross-agent DoS.
   */
  async check(now?: number, intentType?: string, agentId?: string): Promise<string | null> {
    const currentTime = this.clampTime(now);
    const state = await this.getState(intentType, agentId);

    if (state.cooldownUntil > 0) {
      if (currentTime < state.cooldownUntil) {
        const remainingMs = state.cooldownUntil - currentTime;
        const agentInfo = agentId ? ` (agent: ${agentId})` : "";
        return `Circuit breaker open${agentInfo}: ${Math.ceil(remainingMs / 1000)}s cooldown remaining after ${this.config.threshold} consecutive denials`;
      }
      // Cooldown expired — reset
      await this.reset(intentType, agentId);
    }

    return null;
  }

  /**
   * Record the outcome of a policy evaluation.
   * - ALLOW: resets the denial counter
   * - DENY: increments the counter; if threshold reached, enters cooldown
   * - PENDING: no-op (waiting for human, not a denial)
   * MED-20 fix: now parameter is drift-clamped to within 1 hour of Date.now().
   * CORE-011: Accepts optional intentType for per-intent-type state isolation.
   * When provided, records outcome against that specific intent type's state.
   * Falls back to global state when not provided.
   * H-07: Accepts optional agentId for per-agent state isolation. When provided,
   * records outcome against that specific agent's state, preventing a single
   * malicious agent from triggering circuit breaker cooldown for all agents.
   */
  async recordOutcome(decision: "ALLOW" | "DENY" | "PENDING", now?: number, intentType?: string, agentId?: string): Promise<void> {
    // MED-T4-03 NOTE: The getState() + setState() sequence below is NOT atomic.
    // In a multi-instance deployment, concurrent calls to recordOutcome() could both
    // read the same denial count and write count+1, losing an increment. For single-
    // instance deployments this is mitigated by the wallet's execute mutex, which
    // serializes all transaction processing (and thus all recordOutcome calls).
    // See CRIT-10 in the class header for full details and multi-instance recommendations.
    if (decision === "ALLOW") {
      // Success resets the counter
      await this.setState({ denialCount: 0, cooldownUntil: 0 }, intentType, agentId);
      return;
    }

    if (decision === "PENDING") {
      // Pending is not a denial — no-op
      return;
    }

    // DENY: increment counter atomically with state read
    const state = await this.getState(intentType, agentId);
    const newCount = state.denialCount + 1;

    if (newCount >= this.config.threshold) {
      // Enter cooldown
      const currentTime = this.clampTime(now);
      const cooldownExpiry = currentTime + this.config.cooldownMs;
      await this.setState({ denialCount: newCount, cooldownUntil: cooldownExpiry }, intentType, agentId);
    } else {
      await this.setState({ denialCount: newCount, cooldownUntil: state.cooldownUntil }, intentType, agentId);
    }
  }

  /**
   * Reset the circuit breaker — clears counter and cooldown.
   * CRIT-04 fix: Made private. Only called internally when cooldown expires.
   * External code cannot bypass the circuit breaker safety mechanism.
   *
   * MED-16 fix: Now uses a single atomic setState() call instead of two separate
   * store writes, eliminating the crash-window inconsistency from MED-22.
   * CORE-011: Accepts optional intentType for per-intent-type state isolation.
   * H-07: Accepts optional agentId for per-agent state isolation.
   */
  private async reset(intentType?: string, agentId?: string): Promise<void> {
    await this.setState({ denialCount: 0, cooldownUntil: 0 }, intentType, agentId);
  }

  /** Get the current configuration (read-only copy) */
  getConfig(): Readonly<CircuitBreakerConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Check if the circuit breaker is open for any intent type.
   * Checks both the global state key and per-intent-type keys for common intent types.
   * Used by getPolicy() to report circuit breaker status.
   */
  async isOpen(now?: number): Promise<boolean> {
    const currentTime = this.clampTime(now);
    // Check global state
    const globalState = await this.getState();
    if (globalState.cooldownUntil > 0 && currentTime < globalState.cooldownUntil) {
      return true;
    }
    // MED-T5-08 fix: Check per-intent-type states using configurable list
    // instead of hardcoded intent types, so new intent types are not silently missed.
    const intentTypes = this.config.intentTypes ?? DEFAULT_INTENT_TYPES;
    for (const intentType of intentTypes) {
      const state = await this.getState(intentType);
      if (state.cooldownUntil > 0 && currentTime < state.cooldownUntil) {
        return true;
      }
    }
    return false;
  }
}
