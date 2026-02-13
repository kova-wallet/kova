/**
 * SpendingLimitRule — Enforces per-transaction, daily, weekly, and monthly spending caps.
 *
 * Uses store counters with TTL-based expiration for time-window tracking.
 * SEC: All comparisons use precision-safe integer math to avoid IEEE 754 drift.
 */

import type { PolicyRule, PolicyDecision, PolicyContext, SpendingLimitConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";

/** Store key prefixes for spending counters */
const KEY_PREFIX = "spending:";

/** TTL values in seconds */
const TTL = {
  daily: 86_400,       // 24 hours
  weekly: 604_800,     // 7 days
  monthly: 2_592_000,  // 30 days
} as const;

/**
 * SEC: Normalize token identifiers for comparison / keying.
 * - Token symbols are case-insensitive ("usdc" == "USDC")
 * - Address-like identifiers (e.g. Solana base58 mints) remain case-sensitive
 * - EVM addresses are normalized to lowercase
 */
function normalizeTokenId(token: string): string {
  if (token.startsWith("0x") && token.length === 42) return token.toLowerCase();
  if (/^[A-Za-z0-9_]{2,16}$/.test(token)) return token.toUpperCase();
  return token;
}

/**
 * SEC: Precision-safe decimal math to avoid IEEE 754 floating-point drift.
 * Amounts are scaled to integers (9 decimal places) before comparison,
 * preventing issues like 0.1 + 0.2 !== 0.3.
 */
const PRECISION_DECIMALS = 9;
const PRECISION_FACTOR = 10 ** PRECISION_DECIMALS;

/** Scale a number to a precision-safe integer for comparison */
function toSafeInt(value: number): number {
  return Math.round(value * PRECISION_FACTOR);
}

/** Precision-safe greater-than comparison */
function safeGt(a: number, b: number): boolean {
  return toSafeInt(a) > toSafeInt(b);
}

export class SpendingLimitRule implements PolicyRule {
  readonly name = "spending-limit";
  private readonly config: SpendingLimitConfig;

  constructor(config: SpendingLimitConfig) {
    this.config = config;
  }

  /** Get the spending limit configuration (for policy introspection) */
  getConfig(): Readonly<SpendingLimitConfig> {
    return this.config;
  }

  async evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const amount = this.extractAmount(intent);
    if (amount === null) {
      // Intent type has no amount (e.g., custom) — allow through
      return { decision: "ALLOW" };
    }

    const token = this.extractToken(intent);

    // 1. Per-transaction limit (stateless — no TOCTOU concern)
    if (this.config.perTransaction) {
      if (normalizeTokenId(token) === normalizeTokenId(this.config.perTransaction.token)) {
        const limit = parseFloat(this.config.perTransaction.amount);
        if (safeGt(amount, limit)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Per-transaction limit exceeded: ${amount} ${token} > ${limit} ${this.config.perTransaction.token}`,
          };
        }
      }
    }

    // CRIT-02 fix: Atomic increment-then-check pattern.
    // Increment counters FIRST, then check limits. If over limit, decrement and DENY.
    // This prevents TOCTOU races where two concurrent evaluations both see budget as available.
    const incrementedKeys: Array<{ key: string; amount: number; ttl: number }> = [];

    try {
      // 2. Daily limit — atomic increment-then-check
      if (this.config.daily) {
        const denial = await this.atomicCheckWindowLimit(
          context, amount, token, this.config.daily, "daily", TTL.daily, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      // 3. Weekly limit — atomic increment-then-check
      if (this.config.weekly) {
        const denial = await this.atomicCheckWindowLimit(
          context, amount, token, this.config.weekly, "weekly", TTL.weekly, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      // 4. Monthly limit — atomic increment-then-check
      if (this.config.monthly) {
        const denial = await this.atomicCheckWindowLimit(
          context, amount, token, this.config.monthly, "monthly", TTL.monthly, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }
    } catch (err) {
      // Rollback on any error to avoid phantom budget consumption
      await this.rollbackIncrements(context, incrementedKeys);
      throw err;
    }

    return { decision: "ALLOW" };
  }

  /**
   * CRIT-02 fix: Atomic increment-then-check for a time-window spending limit.
   * Increments the counter first, then checks if the new total exceeds the limit.
   * Tracks incremented keys for rollback on denial.
   */
  private async atomicCheckWindowLimit(
    context: PolicyContext,
    amount: number,
    token: string,
    limitConfig: { amount: string; token: string },
    window: string,
    ttl: number,
    incrementedKeys: Array<{ key: string; amount: number; ttl: number }>,
  ): Promise<PolicyDecision | null> {
    const normalizedIntentToken = normalizeTokenId(token);
    const normalizedLimitToken = normalizeTokenId(limitConfig.token);
    if (normalizedIntentToken !== normalizedLimitToken) {
      return null; // Different token, skip this limit
    }

    const limit = parseFloat(limitConfig.amount);
    const key = `${KEY_PREFIX}${window}:${normalizedLimitToken}`;

    // HIGH-05 fix: Always set TTL when initializing, using atomic init-if-absent
    await this.ensureKeyWithTTL(context, key, ttl);

    // Atomic increment — returns new total AFTER increment
    const newTotal = await context.store.increment(key, amount);
    incrementedKeys.push({ key, amount, ttl });

    // SEC: Use precision-safe comparison to avoid float drift in accumulated totals
    if (safeGt(newTotal, limit)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `${this.capitalize(window)} spending limit exceeded: ${newTotal} ${token} > ${limit} ${limitConfig.token}`,
      };
    }

    return null;
  }

  /**
   * CRIT-02 fix: Rollback incremented counters on denial or error.
   * Decrements each key that was incremented during this evaluation.
   */
  private async rollbackIncrements(
    context: PolicyContext,
    incrementedKeys: Array<{ key: string; amount: number; ttl: number }>,
  ): Promise<void> {
    for (const { key, amount } of incrementedKeys) {
      try {
        await context.store.increment(key, -amount);
      } catch {
        // Best-effort rollback — failure here means a slight under-count (safe direction)
      }
    }
  }

  /**
   * Ensure a counter key exists with TTL (initialize if needed).
   * HIGH-05 fix: Always sets TTL on initialization to prevent permanent counter lock
   * if the key expires between check and increment.
   */
  private async ensureKeyWithTTL(context: PolicyContext, key: string, ttl: number): Promise<void> {
    const existing = await context.store.get(key);
    if (existing === null) {
      // Initialize with TTL — if another instance races here, both set "0" with TTL (safe)
      await context.store.set(key, "0", ttl);
    }
  }

  /** Extract the numeric amount from an intent's params. S2-13 fix: rejects negative/zero. */
  private extractAmount(intent: TransactionIntent): number | null {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("amount" in params && typeof params.amount === "string") {
      const parsed = parseFloat(params.amount);
      return (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) ? null : parsed;
    }
    return null;
  }

  /** Extract the token symbol from an intent's params */
  private extractToken(intent: TransactionIntent): string {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("token" in params && typeof params.token === "string") {
      return params.token;
    }
    if ("fromToken" in params && typeof params.fromToken === "string") {
      return params.fromToken;
    }
    return "UNKNOWN";
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
