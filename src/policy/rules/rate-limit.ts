/**
 * RateLimitRule — Limits the number of transactions per time window.
 *
 * Uses store counters with TTL-based expiration:
 * - Per-minute counter expires after 60 seconds
 * - Per-hour counter expires after 3600 seconds
 *
 * **Known limitation (M43 — fixed-window boundary burst):** Because this implementation
 * uses fixed time windows, a caller can issue up to 2x the configured rate at window
 * boundaries. For example, with a limit of N per minute, a caller can send N requests
 * at the very end of one window and N more at the very start of the next, achieving
 * 2N requests within a short timespan. A sliding-window algorithm would eliminate this,
 * but adds complexity and storage overhead.
 *
 * **Current implementation uses fixed windows only (M47).** A sliding-window rate
 * limiting option is planned for a future release. See M47 for tracking.
 *
 * MED-29 note: Counters are incremented on ALLOW; denied transactions are rolled back.
 * This means denied attempts don't consume rate limit capacity, allowing an attacker
 * to probe the rate limit boundary infinitely. This is an intentional trade-off:
 * counting all attempts would cause legitimate transactions to be denied after
 * a burst of invalid ones (DoS via bad requests). The wallet's execute mutex
 * serializes all calls, limiting the probe rate to one at a time.
 *
 * HIGH-17 fix: Counter rollback guarantees under mutex serialization:
 * AgentWallet.execute() serializes calls via a mutex, so only one policy
 * evaluation runs at a time. This means the atomic increment-then-check
 * pattern here is safe from TOCTOU races. On denial, counters are rolled
 * back (decremented). Rollback failures result in slight under-counting
 * which is the safe direction (allows fewer transactions, not more).
 * If the store itself fails, the error propagates up and the transaction
 * is rejected (fail-closed). Store implementations (MemoryStore, SqliteStore)
 * provide atomic increment operations, so partial increments cannot occur.
 */

import type { PolicyRule, PolicyDecision, PolicyContext, RateLimitConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";

const KEY_PREFIX = "ratelimit:";

const TTL = {
  minute: 60,
  hour: 3_600,
} as const;

export class RateLimitRule implements PolicyRule {
  readonly name = "rate-limit";
  private readonly config: RateLimitConfig;
  /** POLICY-007 fix: Scoped key prefix for store keys to avoid counter collisions */
  private readonly scopedKeyPrefix: string;

  constructor(config: RateLimitConfig) {
    // MED-30 fix: Validate rate limit values at construction time to catch
    // misconfigurations early (e.g., NaN, Infinity, negative, or fractional values).
    // L20 fix: Also enforce an upper bound — Number.MAX_SAFE_INTEGER (2^53 - 1) is the
    // largest integer JavaScript can represent exactly; values above it lose precision
    // and could silently weaken the rate limit.
    const MAX_RATE_LIMIT = Number.MAX_SAFE_INTEGER;
    if (config.maxTransactionsPerMinute !== undefined) {
      if (
        !Number.isFinite(config.maxTransactionsPerMinute) ||
        !Number.isInteger(config.maxTransactionsPerMinute) ||
        config.maxTransactionsPerMinute <= 0 ||
        config.maxTransactionsPerMinute > MAX_RATE_LIMIT
      ) {
        throw new Error(
          `RateLimitRule: maxTransactionsPerMinute must be a positive finite integer (<= ${MAX_RATE_LIMIT}), got ${config.maxTransactionsPerMinute}`,
        );
      }
    }
    if (config.maxTransactionsPerHour !== undefined) {
      if (
        !Number.isFinite(config.maxTransactionsPerHour) ||
        !Number.isInteger(config.maxTransactionsPerHour) ||
        config.maxTransactionsPerHour <= 0 ||
        config.maxTransactionsPerHour > MAX_RATE_LIMIT
      ) {
        throw new Error(
          `RateLimitRule: maxTransactionsPerHour must be a positive finite integer (<= ${MAX_RATE_LIMIT}), got ${config.maxTransactionsPerHour}`,
        );
      }
    }
    // POLICY-014 fix: Require at least one limit to be configured. A RateLimitRule
    // with no limits would be a no-op, silently allowing all transactions through.
    if (config.maxTransactionsPerMinute === undefined && config.maxTransactionsPerHour === undefined) {
      throw new Error("RateLimitRule requires at least one limit (maxTransactionsPerMinute or maxTransactionsPerHour)");
    }
    this.config = config;
    // M-07 FIX + POLICY-007 fix: Prepend keyPrefix to all store keys for wallet/agent scoping.
    //
    // M-07 FIX: Without a keyPrefix, rate limit counters are SHARED across all wallet
    // instances using the same store backend, causing counter collisions in multi-wallet
    // deployments. For example, two agents sharing a MemoryStore would share the same
    // "ratelimit:minute" counter, effectively halving each agent's rate limit.
    //
    // CRITICAL: In multi-wallet setups, ALWAYS configure EITHER:
    //   1. A unique keyPrefix per wallet/agent in RateLimitConfig, OR
    //   2. PrefixedStore (from stores/prefixed.ts) to wrap the base store:
    //        new PrefixedStore(baseStore, `wallet:${walletAddress}:`)
    //
    // If neither is configured, a warning is emitted to alert operators.
    if (!config.keyPrefix) {
      process.emitWarning(
        "M-07: RateLimitRule created without keyPrefix. Rate limit counters will be " +
        "shared across all wallet instances using the same store. Configure keyPrefix " +
        "in RateLimitConfig or use PrefixedStore for per-wallet scoping.",
        "KovaRateLimitWarning",
      );
    }
    this.scopedKeyPrefix = config.keyPrefix ? `${config.keyPrefix}:${KEY_PREFIX}` : KEY_PREFIX;
  }

  /** Get the rate limit configuration (for policy introspection) */
  getConfig(): Readonly<RateLimitConfig> {
    return this.config;
  }

  /**
   * HIGH-04 fix: Atomic increment-then-check pattern.
   * Increments counters FIRST, then checks limits. If over limit, rolls back and denies.
   * This prevents TOCTOU races where concurrent evaluations both see counts as available.
   *
   * M47 fix: When algorithm is "sliding-window", uses a log-based approach instead of
   * fixed-window counters. Each transaction appends a timestamp to a store list, and the
   * count is determined by filtering entries within the sliding window. This eliminates
   * the 2x boundary burst vulnerability of fixed-window rate limiting.
   */
  async evaluate(_intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    if (this.config.algorithm === "sliding-window") {
      return this.evaluateSlidingWindow(context);
    }
    return this.evaluateFixedWindow(context);
  }

  /**
   * M47 fix: Sliding window rate limiting using log-based timestamp tracking.
   * Instead of fixed-window counters, each allowed transaction appends a timestamp
   * to a store list. The count of transactions within the window is determined by
   * filtering entries with timestamps within [now - windowMs, now].
   * This eliminates boundary bursts because the window slides with each check.
   */
  private async evaluateSlidingWindow(context: PolicyContext): Promise<PolicyDecision> {
    const now = context.now || Date.now();

    // Check per-minute limit
    if (this.config.maxTransactionsPerMinute !== undefined) {
      const key = `${this.scopedKeyPrefix}sw:minute`;
      const windowMs = 60_000;
      const entries = await context.store.getRecent(key, this.config.maxTransactionsPerMinute + 1);
      const count = entries.filter((entry) => {
        const ts = parseInt(entry, 10);
        return Number.isFinite(ts) && (now - ts) <= windowMs;
      }).length;

      if (count >= this.config.maxTransactionsPerMinute) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Rate limit exceeded: ${count}/${this.config.maxTransactionsPerMinute} transactions per minute (sliding window)`,
        };
      }
    }

    // Check per-hour limit
    if (this.config.maxTransactionsPerHour !== undefined) {
      const key = `${this.scopedKeyPrefix}sw:hour`;
      const windowMs = 3_600_000;
      const entries = await context.store.getRecent(key, this.config.maxTransactionsPerHour + 1);
      const count = entries.filter((entry) => {
        const ts = parseInt(entry, 10);
        return Number.isFinite(ts) && (now - ts) <= windowMs;
      }).length;

      if (count >= this.config.maxTransactionsPerHour) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Rate limit exceeded: ${count}/${this.config.maxTransactionsPerHour} transactions per hour (sliding window)`,
        };
      }
    }

    // All checks passed — append timestamps (read-then-decide pattern, no rollback needed)
    if (this.config.maxTransactionsPerMinute !== undefined) {
      const key = `${this.scopedKeyPrefix}sw:minute`;
      await context.store.append(key, String(now));
    }
    if (this.config.maxTransactionsPerHour !== undefined) {
      const key = `${this.scopedKeyPrefix}sw:hour`;
      await context.store.append(key, String(now));
    }

    return { decision: "ALLOW" };
  }

  /**
   * Original fixed-window rate limiting implementation.
   */
  private async evaluateFixedWindow(context: PolicyContext): Promise<PolicyDecision> {
    const incrementedKeys: Array<{ key: string; ttl: number }> = [];

    try {
      // WARNING (M43): Fixed-window rate limiting is susceptible to boundary bursts.
      // A client can send up to 2x the configured limit in a short burst by timing
      // requests at the boundary between two consecutive windows. For example, with
      // maxTransactionsPerMinute=10, a client could issue 10 requests in the last
      // second of window 1 and 10 more in the first second of window 2, achieving
      // 20 requests in ~2 seconds. This is an inherent property of fixed-window
      // counters. Use algorithm: "sliding-window" to eliminate this.

      // 1. Check per-minute limit (atomic increment-then-check)
      if (this.config.maxTransactionsPerMinute !== undefined) {
        const key = `${this.scopedKeyPrefix}minute`;
        await this.ensureKeyWithTTL(context, key, TTL.minute);
        const newCount = await context.store.increment(key, 1);
        // L25 fix: Reject if counter overflows Number.MAX_SAFE_INTEGER to prevent
        // silent wraparound that could reset the counter and bypass rate limits.
        if (newCount > Number.MAX_SAFE_INTEGER) {
          await this.rollbackIncrements(context, [{ key, ttl: TTL.minute }]);
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Rate limit counter overflow detected",
          };
        }
        // P-04 fix: Only re-apply TTL when the counter is being created (newCount === 1),
        // not on every increment. Resetting TTL on every increment converts the fixed-window
        // semantics into a sliding window, extending the window indefinitely as long as
        // transactions keep arriving. Fixed-window means the window starts when the first
        // transaction arrives and expires after the TTL, regardless of subsequent activity.
        if (newCount === 1) {
          await this.reapplyTTLIfNeeded(context, key, String(newCount), TTL.minute);
        }
        incrementedKeys.push({ key, ttl: TTL.minute });

        if (newCount > this.config.maxTransactionsPerMinute) {
          await this.rollbackIncrements(context, incrementedKeys);
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Rate limit exceeded: ${newCount - 1}/${this.config.maxTransactionsPerMinute} transactions per minute already used`,
          };
        }
      }

      // 2. Check per-hour limit (atomic increment-then-check)
      if (this.config.maxTransactionsPerHour !== undefined) {
        const key = `${this.scopedKeyPrefix}hour`;
        await this.ensureKeyWithTTL(context, key, TTL.hour);
        const newCount = await context.store.increment(key, 1);
        // L25 fix: Counter overflow protection (see minute block comment above)
        if (newCount > Number.MAX_SAFE_INTEGER) {
          await this.rollbackIncrements(context, [...incrementedKeys, { key, ttl: TTL.hour }]);
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Rate limit counter overflow detected",
          };
        }
        // P-04 fix: Only re-apply TTL on counter creation (see minute block comment above)
        if (newCount === 1) {
          await this.reapplyTTLIfNeeded(context, key, String(newCount), TTL.hour);
        }
        incrementedKeys.push({ key, ttl: TTL.hour });

        if (newCount > this.config.maxTransactionsPerHour) {
          await this.rollbackIncrements(context, incrementedKeys);
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Rate limit exceeded: ${newCount - 1}/${this.config.maxTransactionsPerHour} transactions per hour already used`,
          };
        }
      }
    } catch (err) {
      await this.rollbackIncrements(context, incrementedKeys);
      throw err;
    }

    return { decision: "ALLOW" };
  }

  /**
   * HIGH-04 fix: Rollback incremented counters on denial or error.
   */
  private async rollbackIncrements(
    context: PolicyContext,
    incrementedKeys: Array<{ key: string; ttl: number }>,
  ): Promise<void> {
    for (const { key } of incrementedKeys) {
      try {
        // POLICY-006 fix: Clamp to zero after decrement to prevent negative counters.
        // If the counter's TTL expires between increment and rollback, the counter
        // resets to 0 and decrementing produces -1, which would grant one extra
        // transaction beyond the configured rate limit.
        const newValue = await context.store.increment(key, -1);
        if (newValue < 0) {
          await context.store.set(key, "0");
        }
      } catch {
        // Best-effort rollback — failure here means a slight under-count (safe direction)
      }
    }
  }

  /**
   * Ensure a counter key exists with TTL (initialize if needed).
   * MED-04 fix: Uses atomic setIfNotExists to prevent TOCTOU race where concurrent
   * calls to get()+set() could reset a counter's TTL, erasing rate limit counts.
   */
  private async ensureKeyWithTTL(context: PolicyContext, key: string, ttl: number): Promise<void> {
    await context.store.setIfNotExists(key, "0", ttl);
  }

  /**
   * HIGH-22 fix: Re-apply TTL on a counter key after increment to close the race
   * where the TTL set by setIfNotExists expires before increment() runs. In that
   * scenario, increment() creates a new counter entry without a TTL, causing the
   * counter to persist indefinitely and permanently block the rate limit once it
   * reaches the threshold. By checking whether the counter lost its TTL (via get()
   * returning a value that was just incremented from zero with no prior key), we
   * unconditionally re-set the value with the TTL to ensure expiration.
   *
   * This uses set() which overwrites the value with TTL. It is safe because:
   * 1. The wallet's execute mutex serializes all evaluations (no concurrent increment)
   * 2. We use the value returned by increment() so no data is lost
   * 3. The TTL is always the full window duration (not remaining time), which at
   *    worst extends the window slightly — the safe direction for rate limiting
   */
  private async reapplyTTLIfNeeded(
    context: PolicyContext,
    key: string,
    value: string,
    ttl: number,
  ): Promise<void> {
    // If the counter was just created by increment() (value is 1 after our increment
    // of 1), the TTL from setIfNotExists may have expired. Re-apply to be safe.
    // For higher counts, the key already existed with a TTL, so this is a no-op
    // in terms of correctness (it refreshes the TTL, which is the safe direction).
    // We always re-apply rather than checking, because checking would introduce
    // another TOCTOU window.
    await context.store.set(key, value, ttl);
  }
}
