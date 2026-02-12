/**
 * CircuitBreaker — Tracks consecutive policy denials and enters a cooldown
 * period after N denials to prevent runaway agent behavior.
 *
 * Operates at the wallet level (before policy evaluation) so it cannot be
 * bypassed by reconfiguring rules.
 *
 * Store keys: circuit:denial_count, circuit:cooldown_until
 */

import type { Store } from "../stores/interface.js";

/** Configuration for the circuit breaker */
export interface CircuitBreakerConfig {
  /** Number of consecutive denials before circuit opens. Must be >= 1. Default: 5 */
  threshold: number;
  /** Cooldown period in milliseconds. Must be >= 0. Default: 300_000 (5 min) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  threshold: 5,
  cooldownMs: 300_000,
};

/** Store key for the consecutive denial counter */
const DENIAL_COUNT_KEY = "circuit:denial_count";
/** Store key for the cooldown expiry timestamp */
const COOLDOWN_UNTIL_KEY = "circuit:cooldown_until";

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

  constructor(store: Store, config?: Partial<CircuitBreakerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };

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
   * Check whether the circuit breaker is currently blocking.
   * Returns null if OK, or a denial reason string if blocked.
   *
   * Automatically resets the circuit after the cooldown period expires.
   */
  async check(now?: number): Promise<string | null> {
    const currentTime = now ?? Date.now();

    // S6-12 fix: Check for both null and empty string to avoid redundant reset() calls
    const cooldownUntil = await this.store.get(COOLDOWN_UNTIL_KEY);
    if (cooldownUntil !== null && cooldownUntil !== "") {
      const expiresAt = parseInt(cooldownUntil, 10);
      if (!isNaN(expiresAt) && currentTime < expiresAt) {
        const remainingMs = expiresAt - currentTime;
        return `Circuit breaker open: ${Math.ceil(remainingMs / 1000)}s cooldown remaining after ${this.config.threshold} consecutive denials`;
      }
      // Cooldown expired — reset
      await this.reset();
    }

    return null;
  }

  /**
   * Record the outcome of a policy evaluation.
   * - ALLOW: resets the denial counter
   * - DENY: increments the counter; if threshold reached, enters cooldown
   * - PENDING: no-op (waiting for human, not a denial)
   */
  async recordOutcome(decision: "ALLOW" | "DENY" | "PENDING", now?: number): Promise<void> {
    if (decision === "ALLOW") {
      // Success resets the counter
      await this.store.set(DENIAL_COUNT_KEY, "0");
      return;
    }

    if (decision === "PENDING") {
      // Pending is not a denial — no-op
      return;
    }

    // DENY: increment counter
    const newCount = await this.store.increment(DENIAL_COUNT_KEY, 1);

    if (newCount >= this.config.threshold) {
      // Enter cooldown
      const currentTime = now ?? Date.now();
      const cooldownExpiry = currentTime + this.config.cooldownMs;
      await this.store.set(COOLDOWN_UNTIL_KEY, String(cooldownExpiry));
    }
  }

  /**
   * Reset the circuit breaker — clears counter and cooldown.
   * CRIT-04 fix: Made private. Only called internally when cooldown expires.
   * External code cannot bypass the circuit breaker safety mechanism.
   */
  private async reset(): Promise<void> {
    await this.store.set(DENIAL_COUNT_KEY, "0");
    await this.store.set(COOLDOWN_UNTIL_KEY, "");
  }

  /** Get the current configuration (read-only copy) */
  getConfig(): Readonly<CircuitBreakerConfig> {
    return Object.freeze({ ...this.config });
  }
}
