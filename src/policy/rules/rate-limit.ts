/**
 * RateLimitRule — Limits the number of transactions per time window.
 *
 * Uses store counters with TTL-based expiration:
 * - Per-minute counter expires after 60 seconds
 * - Per-hour counter expires after 3600 seconds
 *
 * Counters are incremented on ALLOW, so denied transactions don't count.
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

  constructor(config: RateLimitConfig) {
    this.config = config;
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
        const key = `${KEY_PREFIX}minute`;
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
        const key = `${KEY_PREFIX}hour`;
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
   * HIGH-05 fix: Always sets TTL on initialization to prevent permanent counter lock.
   */
  private async ensureKeyWithTTL(context: PolicyContext, key: string, ttl: number): Promise<void> {
    const existing = await context.store.get(key);
    if (existing === null) {
      await context.store.set(key, "0", ttl);
    }
  }
}
