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

/** MED-33 fix: Maximum length for agentId to prevent key bloat and abuse */
const MAX_AGENT_ID_LENGTH = 64;

/** MED-33 fix: Regex for valid agentId characters (alphanumeric, hyphens, underscores) */
const VALID_AGENT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * MED-33 fix: Threshold for unique agentIds before emitting an abuse warning.
 * If more than this many distinct agentIds are seen, it suggests an agent may be
 * rotating IDs to bypass per-agent circuit breaker isolation.
 */
const MAX_UNIQUE_AGENT_IDS = 100;

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
  /**
   * ARCH-01 fix: When true, initialize() throws an error instead of logging a
   * warning when another instance is detected sharing the same store. This enforces
   * the single-instance requirement at startup, preventing silent security degradation.
   * Default: false (warning only, for backwards compatibility).
   */
  failOnMultiInstance?: boolean;
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
  /**
   * MED-33 fix: Track unique agentIds to detect potential abuse via ID rotation.
   * If an agent rotates IDs to bypass per-agent circuit breaker isolation, the
   * growing set size triggers a warning at MAX_UNIQUE_AGENT_IDS.
   */
  private readonly seenAgentIds: Set<string> = new Set();
  /** MED-33 fix: Whether the agent ID abuse warning has already been emitted */
  private agentIdAbuseWarned = false;

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

    // CONC-15 fix: Use setIfNotExists for initial instance registration.
    // If another instance already registered, setIfNotExists returns false,
    // providing a reliable detection mechanism instead of the previous
    // get-then-set pattern which had a TOCTOU window where two instances
    // starting simultaneously could both see "no existing instance."
    try {
      const claimed = await this.store.setIfNotExists(INSTANCE_KEY, this.instanceId, INSTANCE_TTL_SECONDS);
      if (!claimed) {
        // Another instance already holds the slot — check who
        const existing = await this.store.get(INSTANCE_KEY);
        if (existing && existing !== this.instanceId) {
          const message =
            "[KOVA CRITICAL] Multiple instances detected sharing the same store. " +
            "This breaks security guarantees including mutex serialization, idempotency, " +
            "spending limits, and audit hash chains. Use a single instance or implement " +
            "distributed locking. " +
            `(existing: ${existing.slice(0, 8)}..., this: ${this.instanceId.slice(0, 8)}...)`;
          // ARCH-01 fix: When failOnMultiInstance is true, throw an error instead of
          // just logging a warning. This enforces the single-instance requirement.
          if (this.config.failOnMultiInstance) {
            throw new Error(message);
          }
          process.emitWarning(
            "Multiple instances detected sharing the same store. " +
            "This breaks security guarantees including mutex serialization, idempotency, " +
            "spending limits, and audit hash chains. Use a single instance or implement " +
            "distributed locking.",
            { code: "KOVA_MULTI_INSTANCE_WARNING" },
          );
        }
        // Overwrite with our ID (we're taking over, but with a warning logged)
        await this.store.set(INSTANCE_KEY, this.instanceId, INSTANCE_TTL_SECONDS);
      }
    } catch (err: unknown) {
      // Re-throw multi-instance errors when failOnMultiInstance is true —
      // they must not be swallowed by the store-error catch block.
      if (this.config.failOnMultiInstance && err instanceof Error && err.message.includes("[KOVA CRITICAL]")) {
        throw err;
      }
      // HIGH-25 fix: Use process.emitWarning instead of console.error to avoid leaking
      // error details to stderr. The error message may contain store connection info.
      process.emitWarning(
        "Failed to perform multi-instance detection",
        { code: "KOVA_INTERNAL_WARNING" },
      );
    }

    // Refresh instance ID periodically so the TTL doesn't expire while running
    this.heartbeatInterval = setInterval(() => {
      void this.store.set(INSTANCE_KEY, this.instanceId, INSTANCE_TTL_SECONDS).catch((_err: unknown) => {
        // HIGH-25 fix: Use process.emitWarning instead of console.error to avoid
        // leaking store error details to stderr.
        process.emitWarning(
          "Failed to refresh instance heartbeat",
          { code: "KOVA_INTERNAL_WARNING" },
        );
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
   * MED-33 fix: Sanitize and validate an agentId. Enforces:
   * - Maximum length of MAX_AGENT_ID_LENGTH (64) characters
   * - Only alphanumeric characters, hyphens, and underscores
   * - Tracks unique agentIds and emits a warning if too many are seen
   *
   * Returns the sanitized agentId, or undefined if the input was undefined.
   * Throws if the agentId is invalid (wrong characters or too long).
   */
  private sanitizeAgentId(agentId: string | undefined): string | undefined {
    if (agentId === undefined) return undefined;

    if (agentId.length > MAX_AGENT_ID_LENGTH) {
      throw new Error(
        `CircuitBreaker: agentId exceeds maximum length of ${MAX_AGENT_ID_LENGTH} characters (got ${agentId.length})`,
      );
    }
    if (!VALID_AGENT_ID_REGEX.test(agentId)) {
      throw new Error(
        `CircuitBreaker: agentId contains invalid characters. Only alphanumeric, hyphens, and underscores are allowed.`,
      );
    }

    // Track unique agentIds for abuse detection
    this.seenAgentIds.add(agentId);
    if (this.seenAgentIds.size >= MAX_UNIQUE_AGENT_IDS && !this.agentIdAbuseWarned) {
      this.agentIdAbuseWarned = true;
      process.emitWarning(
        `CircuitBreaker: ${this.seenAgentIds.size} unique agentIds detected. This may indicate ` +
        `an agent rotating IDs to bypass per-agent circuit breaker isolation. ` +
        `Consider enforcing agentId at the application layer.`,
        { code: "KOVA_AGENT_ID_ABUSE_WARNING" },
      );
    }

    return agentId;
  }

  /**
   * CRIT-11 fix: Resolve the store key for the dedicated atomic denial counter.
   * Uses store.increment() for atomic counting, avoiding the TOCTOU race in the
   * previous getState()+setState() pattern where concurrent calls could both read
   * the same denial count and write count+1, losing an increment.
   *
   * The key follows the pattern: circuit:denials:{agentId}:{intentType}
   * Sanitization matches stateKey() to prevent key injection via `:` separators.
   */
  private denialCountKey(intentType?: string, agentId?: string): string {
    let key = "circuit:denials";
    if (agentId) {
      const sanitizedAgentId = agentId.replace(/:/g, "_");
      key = `${key}:${sanitizedAgentId}`;
    }
    if (intentType) {
      const sanitizedIntentType = intentType.replace(/:/g, "_");
      key = `${key}:${sanitizedIntentType}`;
    }
    return key;
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
      // POLICY-009 fix: Sanitize agentId to prevent key injection via `:` separators.
      // An agentId containing `:` could collide with another agent's key space
      // (e.g., agentId "foo:agent:bar" would produce a key overlapping with agent "bar").
      const sanitizedAgentId = agentId.replace(/:/g, "_");
      key = `${key}:agent:${sanitizedAgentId}`;
    }
    if (intentType) {
      // POLICY-009 fix: Also sanitize intentType for consistency.
      const sanitizedIntentType = intentType.replace(/:/g, "_");
      key = `${key}:${sanitizedIntentType}`;
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
        // HIGH-25 fix: Use process.emitWarning instead of console.error
        process.emitWarning(
          "Circuit breaker state has unexpected shape — failing CLOSED (blocking). " +
          "This is a safety measure: corrupted state denies transactions rather than allowing them.",
          { code: "KOVA_SECURITY_WARNING" },
        );
        return { denialCount: Infinity, cooldownUntil: Infinity };
      } catch {
        // M-39 fix: FAIL-CLOSED on corrupted/unparseable state.
        // Previously this fell through to the default (open/allow) state, meaning
        // corrupted state would silently disable the circuit breaker. Now we treat
        // parse failures as circuit-open (deny) to maintain safety invariants.
        // HIGH-25 fix: Use process.emitWarning instead of console.error to avoid
        // leaking corrupted state details to stderr.
        process.emitWarning(
          "Circuit breaker state corrupted — failing CLOSED (blocking). " +
          "This is a safety measure: corrupted state denies transactions rather than allowing them.",
          { code: "KOVA_SECURITY_WARNING" },
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
    // MED-33 fix: Sanitize agentId to prevent key injection and detect ID rotation abuse
    const sanitizedAgentId = this.sanitizeAgentId(agentId);
    const currentTime = this.clampTime(now);
    const state = await this.getState(intentType, sanitizedAgentId);

    if (state.cooldownUntil > 0) {
      if (currentTime < state.cooldownUntil) {
        const remainingMs = state.cooldownUntil - currentTime;
        const agentInfo = sanitizedAgentId ? ` (agent: ${sanitizedAgentId})` : "";
        return `Circuit breaker open${agentInfo}: ${Math.ceil(remainingMs / 1000)}s cooldown remaining after ${this.config.threshold} consecutive denials`;
      }
      // Cooldown expired — reset
      await this.reset(intentType, sanitizedAgentId);
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
    // MED-33 fix: Sanitize agentId to prevent key injection and detect ID rotation abuse
    const sanitizedAgentId = this.sanitizeAgentId(agentId);
    // CONC-05 cross-reference: The TOCTOU between check() and recordOutcome() is
    // documented in CRIT-10 (class header) and mitigated by the wallet's execute mutex
    // for single-instance deployments. For multi-instance, use store-level atomic
    // compare-and-swap or Redis Lua scripts. See security_audit_team9 CONC-05.
    //
    // CRIT-11 fix: The denial counter increment is now atomic via store.increment()
    // on a dedicated counter key. The previous getState() + setState() pattern was a
    // classic TOCTOU where concurrent calls could both read the same denialCount and
    // write count+1, losing an increment. store.increment() is atomic in both
    // MemoryStore (synchronous single-threaded JS) and SqliteStore (SQLite transaction).
    if (decision === "ALLOW") {
      // CRIT-11 fix: Reset both the atomic denial counter and the JSON state.
      // The denial counter key is reset to "0" via store.set() and the combined
      // JSON state is cleared via setState(). Both must be reset to prevent stale
      // counter values from persisting across ALLOW resets.
      await this.store.set(this.denialCountKey(intentType, sanitizedAgentId), "0");
      await this.setState({ denialCount: 0, cooldownUntil: 0 }, intentType, sanitizedAgentId);
      return;
    }

    if (decision === "PENDING") {
      // Pending is not a denial — no-op
      return;
    }

    // CRIT-11 fix: DENY — use store.increment() for atomic denial counting.
    // Previously this method used getState() + setState() which is a classic TOCTOU:
    // two concurrent calls could both read the same denialCount and write count+1,
    // losing an increment. Now we use store.increment() on a dedicated counter key
    // which IS atomic in both MemoryStore (synchronous JS) and SqliteStore (SQLite
    // transaction). Only when the threshold is reached do we write cooldown metadata
    // via setState(), which is a one-way state transition (not a read-modify-write).
    const newCount = await this.store.increment(this.denialCountKey(intentType, sanitizedAgentId), 1);

    if (newCount >= this.config.threshold) {
      // Enter cooldown — this is a one-way transition, not a read-modify-write,
      // so the TOCTOU concern does not apply to the cooldown write itself.
      const currentTime = this.clampTime(now);
      const cooldownExpiry = currentTime + this.config.cooldownMs;
      await this.setState({ denialCount: newCount, cooldownUntil: cooldownExpiry }, intentType, sanitizedAgentId);
    } else {
      // Update denialCount in JSON state for consistency with getState() readers
      // (e.g., isOpen() and check() which read the JSON state). Read current state
      // to preserve any existing cooldownUntil value.
      const state = await this.getState(intentType, sanitizedAgentId);
      await this.setState({ denialCount: newCount, cooldownUntil: state.cooldownUntil }, intentType, sanitizedAgentId);
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
    // CRIT-11 fix: Reset both the atomic denial counter key and the JSON state.
    // Without resetting the counter key, a stale denial count would persist and
    // could cause the circuit breaker to re-trigger prematurely after a cooldown reset.
    await this.store.set(this.denialCountKey(intentType, agentId), "0");
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
   *
   * POLICY-014 fix: Optionally accepts an agentId to also check per-agent keys.
   * Without agentId, only global and per-intent-type states are checked (which may
   * miss per-agent circuit breaks). Callers with access to the agentId should pass it.
   */
  async isOpen(now?: number, agentId?: string): Promise<boolean> {
    // MED-33 fix: Sanitize agentId to prevent key injection and detect ID rotation abuse
    const sanitizedAgentId = this.sanitizeAgentId(agentId);
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
      // POLICY-014 fix: Also check per-agent+intent-type compound keys
      if (sanitizedAgentId) {
        const agentState = await this.getState(intentType, sanitizedAgentId);
        if (agentState.cooldownUntil > 0 && currentTime < agentState.cooldownUntil) {
          return true;
        }
      }
    }
    // POLICY-014 fix: Check per-agent global state (no intent type)
    if (sanitizedAgentId) {
      const agentGlobal = await this.getState(undefined, sanitizedAgentId);
      if (agentGlobal.cooldownUntil > 0 && currentTime < agentGlobal.cooldownUntil) {
        return true;
      }
    }
    return false;
  }
}
