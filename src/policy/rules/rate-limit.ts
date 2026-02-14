/**
 * RateLimitRule — Limits the number of transactions per time window.
 *
 * Uses store counters with TTL-based expiration:
 * - Per-minute counter expires after 60 seconds
 * - Per-hour counter expires after 3600 seconds
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
    if (config.maxTransactionsPerMinute !== undefined) {
      if (
        !Number.isFinite(config.maxTransactionsPerMinute) ||
        !Number.isInteger(config.maxTransactionsPerMinute) ||
        config.maxTransactionsPerMinute <= 0
      ) {
        throw new Error(
          `RateLimitRule: maxTransactionsPerMinute must be a positive finite integer, got ${config.maxTransactionsPerMinute}`,
        );
      }
    }
    if (config.maxTransactionsPerHour !== undefined) {
      if (
        !Number.isFinite(config.maxTransactionsPerHour) ||
        !Number.isInteger(config.maxTransactionsPerHour) ||
        config.maxTransactionsPerHour <= 0
      ) {
        throw new Error(
          `RateLimitRule: maxTransactionsPerHour must be a positive finite integer, got ${config.maxTransactionsPerHour}`,
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
   */
  async evaluate(_intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const incrementedKeys: Array<{ key: string; ttl: number }> = [];

    try {
      // 1. Check per-minute limit (atomic increment-then-check)
      if (this.config.maxTransactionsPerMinute !== undefined) {
        const key = `${this.scopedKeyPrefix}minute`;
        await this.ensureKeyWithTTL(context, key, TTL.minute);
        const newCount = await context.store.increment(key, 1);
        incrementedKeys.push({ key, ttl: TTL.minute });

        if (newCount > this.config.maxTransactionsPerMinute) {
          await this.rollbackIncrements(context, incrementedKeys);
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Rate limit exceeded: ${newCount}/${this.config.maxTransactionsPerMinute} transactions per minute`,
          };
        }
      }

      // 2. Check per-hour limit (atomic increment-then-check)
      if (this.config.maxTransactionsPerHour !== undefined) {
        const key = `${this.scopedKeyPrefix}hour`;
        await this.ensureKeyWithTTL(context, key, TTL.hour);
        const newCount = await context.store.increment(key, 1);
        incrementedKeys.push({ key, ttl: TTL.hour });

        if (newCount > this.config.maxTransactionsPerHour) {
          await this.rollbackIncrements(context, incrementedKeys);
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Rate limit exceeded: ${newCount}/${this.config.maxTransactionsPerHour} transactions per hour`,
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
        await context.store.increment(key, -1);
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
}
