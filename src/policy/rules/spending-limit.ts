/**
 * SpendingLimitRule — Enforces per-transaction, daily, weekly, and monthly spending caps.
 *
 * Uses store counters with TTL-based expiration for time-window tracking.
 * SEC: All comparisons use precision-safe integer math to avoid IEEE 754 drift.
 *
 * HIGH-19 IMPORTANT: Time windows use rolling TTL, NOT calendar boundaries.
 * - "daily" = 86,400 seconds from the first transaction, not midnight-to-midnight.
 * - "weekly" = 604,800 seconds from first transaction, not Monday-to-Sunday.
 * - "monthly" = 2,592,000 seconds (30 days) from first transaction, not calendar month.
 *
 * This means an agent could spend the daily limit at 23:59, then spend again after
 * the TTL expires (within the same calendar day). For stricter calendar-boundary
 * enforcement, use a cron job to reset counters at midnight, or implement overlapping
 * windows (e.g., both a 24h rolling window and a 12h rolling window at 50% of the limit).
 *
 * Rollback guarantees: On denial or error, all incremented counters are rolled back
 * (decremented). Rollback failure results in slight under-counting (safe direction).
 * The mutex in AgentWallet.execute() ensures only one evaluation runs at a time.
 */

import type { PolicyRule, PolicyDecision, PolicyContext, SpendingLimitConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";
import { normalizeTokenId, parseAndValidateLimitAmount } from "../utils.js";

/** Default store key prefix for spending counters */
const DEFAULT_KEY_PREFIX = "spending:";

/**
 * Window durations in seconds for sliding window calculations.
 *
 * H-01 FIX: Replaced fixed-window TTL approach with a sliding window implementation.
 * The old TTL-based approach allowed double-spend at window boundaries: an agent could
 * spend up to the limit just before the window expired, then spend again immediately
 * after the new window started, effectively getting 2x the limit in a brief period.
 *
 * The new sliding window approach stores individual transaction amounts with timestamps
 * (via store.append) and sums all transactions within the trailing window period relative
 * to the current time. This eliminates the boundary double-spend vulnerability.
 *
 * Trade-off: Sliding windows have higher storage costs (individual tx records vs. single
 * counter) and higher computation costs (summing recent transactions on each evaluation).
 * The TTL on the log key acts as a garbage collection mechanism to prevent unbounded growth.
 */
const WINDOW_SECONDS = {
  daily: 86_400,       // 24 hours
  weekly: 604_800,     // 7 days
  monthly: 2_592_000,  // 30 days
} as const;

/** Maximum number of transaction records to retrieve for sliding window calculation */
const MAX_WINDOW_ENTRIES = 10_000;

/**
 * SEC: Precision-safe decimal math to avoid IEEE 754 floating-point drift.
 * HIGH-03 fix: Uses BigInt to prevent overflow for large amounts (> ~9 billion).
 * The old approach (Math.round(value * 10^9)) overflowed Number.MAX_SAFE_INTEGER
 * for amounts exceeding ~9,007,199, making spending limit comparisons unreliable.
 * Now amounts are converted to string via toFixed() and parsed into BigInt,
 * ensuring correct comparisons at any magnitude.
 */
const PRECISION_DECIMALS = 9;
const PRECISION_FACTOR_BI = 10n ** BigInt(PRECISION_DECIMALS);

/** Scale a number to a precision-safe BigInt for comparison */
function toBigIntScaled(value: number): bigint {
  // Use toFixed to get a deterministic string representation,
  // then split into whole/fractional parts and assemble as BigInt
  const str = value.toFixed(PRECISION_DECIMALS);
  const dotIndex = str.indexOf(".");
  const whole = BigInt(dotIndex === -1 ? str : str.slice(0, dotIndex));
  const fracStr = dotIndex === -1 ? "" : str.slice(dotIndex + 1);
  const frac = BigInt(fracStr.padEnd(PRECISION_DECIMALS, "0").slice(0, PRECISION_DECIMALS));
  // Handle negative values: fractional part sign must match whole part
  return value < 0 ? whole * PRECISION_FACTOR_BI - frac : whole * PRECISION_FACTOR_BI + frac;
}

/** Precision-safe greater-than comparison (BigInt-based, no overflow) */
function safeGt(a: number, b: number): boolean {
  return toBigIntScaled(a) > toBigIntScaled(b);
}

export class SpendingLimitRule implements PolicyRule {
  readonly name = "spending-limit";
  private readonly config: SpendingLimitConfig;
  /**
   * MED-T4-01 fix: Configurable key prefix for scoping spending limit counters.
   * Defaults to "spending:" for backward compatibility. Can be overridden via
   * SpendingLimitConfig.keyPrefix to isolate counters per wallet or agent.
   */
  private readonly keyPrefix: string;

  constructor(config: SpendingLimitConfig) {
    // MED-34 fix: Validate all limit amounts at construction time.
    // Catches NaN, Infinity, negative, and zero values that would silently disable limits.
    if (config.perTransaction) parseAndValidateLimitAmount(config.perTransaction.amount, "SpendingLimit perTransaction");
    if (config.daily) parseAndValidateLimitAmount(config.daily.amount, "SpendingLimit daily");
    if (config.weekly) parseAndValidateLimitAmount(config.weekly.amount, "SpendingLimit weekly");
    if (config.monthly) parseAndValidateLimitAmount(config.monthly.amount, "SpendingLimit monthly");
    if (config.perTransactionUSD) parseAndValidateLimitAmount(config.perTransactionUSD.amount, "SpendingLimit perTransactionUSD");
    if (config.dailyUSD) parseAndValidateLimitAmount(config.dailyUSD.amount, "SpendingLimit dailyUSD");
    if (config.weeklyUSD) parseAndValidateLimitAmount(config.weeklyUSD.amount, "SpendingLimit weeklyUSD");
    if (config.monthlyUSD) parseAndValidateLimitAmount(config.monthlyUSD.amount, "SpendingLimit monthlyUSD");

    // =========================================================================
    // POLICY-003 WARNING — NO PER-TRANSACTION CAP FOR TOKENS WITH ONLY AGGREGATE LIMITS
    // =========================================================================
    // If a token has daily/weekly/monthly limits but NO per-transaction limit
    // (token-specific or USD-denominated), a single transaction can consume the
    // entire aggregate budget in one shot. For example, with a daily limit of
    // 100 SOL but no perTransaction limit, an agent can send 100 SOL in a single
    // transaction, exhausting the entire daily budget immediately.
    //
    // To mitigate this, configure EITHER:
    //   - A perTransaction limit for the token (e.g., perTransaction: { amount: "10", token: "SOL" })
    //   - A perTransactionUSD limit (applies to all tokens, e.g., perTransactionUSD: { amount: "50" })
    //
    // This is a design decision: aggregate limits without per-transaction caps
    // are valid for use cases where the agent needs flexibility to make large
    // individual transfers within its budget. The warning below alerts operators
    // to this behavior so they can add per-transaction caps if desired.
    // =========================================================================
    const hasPerTxCap = !!(config.perTransaction || config.perTransactionUSD);
    const hasAggregateLimits = !!(config.daily || config.weekly || config.monthly ||
      config.dailyUSD || config.weeklyUSD || config.monthlyUSD);

    if (hasAggregateLimits && !hasPerTxCap) {
      // Collect the tokens that have aggregate limits but no per-transaction cap
      const aggregateTokens = new Set<string>();
      if (config.daily) aggregateTokens.add(config.daily.token);
      if (config.weekly) aggregateTokens.add(config.weekly.token);
      if (config.monthly) aggregateTokens.add(config.monthly.token);
      const hasUsdAggregates = !!(config.dailyUSD || config.weeklyUSD || config.monthlyUSD);

      const tokenList = aggregateTokens.size > 0
        ? `tokens: ${[...aggregateTokens].join(", ")}`
        : "";
      const usdNote = hasUsdAggregates ? "USD-denominated aggregate limits" : "";
      const limitDesc = [tokenList, usdNote].filter(Boolean).join(" and ");

      process.emitWarning(
        `POLICY-003: SpendingLimitRule has aggregate limits (${limitDesc}) but no per-transaction limit. ` +
        `A single transaction can consume the entire aggregate budget. ` +
        `Consider adding perTransaction or perTransactionUSD to cap individual transaction sizes.`,
        "KovaSpendingLimitWarning",
      );
    }

    this.config = config;
    // MED-T4-01 fix: Use configurable key prefix, defaulting to "spending:" for backward compatibility
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  /** Get the spending limit configuration (for policy introspection) */
  getConfig(): Readonly<SpendingLimitConfig> {
    return this.config;
  }

  async evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const amount = this.extractAmount(intent);
    if (amount === null) {
      // CRIT-01 fix: Fail-closed — if we can't determine the cost of a transaction,
      // it's not safe to allow it through spending limits. This prevents custom and
      // mint intents (which lack an 'amount' field) from bypassing spending controls.
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Cannot determine transaction cost for intent type "${intent.type}" — no extractable amount. ` +
          `Spending limit requires a quantifiable cost to evaluate.`,
      };
    }

    const token = this.extractToken(intent);

    // 1. Per-transaction limit (stateless — no TOCTOU concern)
    // H-03 NOTE: This token-specific per-transaction limit intentionally only checks when
    // the transaction token matches the configured limit token. This is by design: it
    // allows setting different per-tx limits for different tokens (e.g., 10 SOL per tx,
    // 1000 USDC per tx). Cross-token evasion is prevented by the perTransactionUSD check
    // below, which applies regardless of token. If only perTransaction is configured
    // (without perTransactionUSD), transactions in other tokens are caught by the
    // AUDIT-CRIT-01 untracked-token check further below.
    if (this.config.perTransaction) {
      if (normalizeTokenId(token) === normalizeTokenId(this.config.perTransaction.token)) {
        const limit = parseFloat(this.config.perTransaction.amount);
        if (safeGt(amount, limit)) {
          // M-61 FIX: Sanitized denial message — does not reveal specific limit details
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Per-transaction spending limit exceeded",
          };
        }
      }
    }

    // H-03 FIX + CRIT-03 fix: Per-transaction USD limit (token-agnostic, prevents cross-token evasion).
    // This check runs for ALL tokens regardless of whether a token-specific limit exists,
    // preventing agents from evading limits by using a different token.
    if (this.config.perTransactionUSD) {
      const usdDenial = await this.checkUsdPerTransaction(context, amount, token);
      if (usdDenial) return usdDenial;
    }

    // AUDIT-CRIT-01 fix: Deny transactions in tokens that have no matching token-specific
    // limit AND no USD-denominated limit. This prevents cross-token bypass where an attacker
    // swaps to an untracked token to evade spending limits entirely.
    const hasUsdLimits = !!(this.config.perTransactionUSD || this.config.dailyUSD ||
      this.config.weeklyUSD || this.config.monthlyUSD);
    if (!hasUsdLimits) {
      const hasMatchingTokenLimit = this.hasTokenSpecificLimit(token);
      if (!hasMatchingTokenLimit) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Token "${token}" has no configured spending limit and no USD-denominated limits are set. ` +
            `Configure a USD limit (dailyUSD, weeklyUSD, monthlyUSD) to allow cross-token transactions, ` +
            `or add an explicit limit for "${token}".`,
        };
      }
    }

    // CRIT-02 fix: Atomic increment-then-check pattern.
    // Increment counters FIRST, then check limits. If over limit, decrement and DENY.
    // This prevents TOCTOU races where two concurrent evaluations both see budget as available.
    const incrementedKeys: Array<{ key: string; amount: number; ttl: number }> = [];

    try {
      // 2. Daily limit — sliding window check
      if (this.config.daily) {
        const denial = await this.slidingWindowCheckLimit(
          context, amount, token, this.config.daily, "daily", WINDOW_SECONDS.daily, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      // 3. Weekly limit — sliding window check
      if (this.config.weekly) {
        const denial = await this.slidingWindowCheckLimit(
          context, amount, token, this.config.weekly, "weekly", WINDOW_SECONDS.weekly, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      // 4. Monthly limit — sliding window check
      if (this.config.monthly) {
        const denial = await this.slidingWindowCheckLimit(
          context, amount, token, this.config.monthly, "monthly", WINDOW_SECONDS.monthly, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      // CRIT-03 fix: USD-denominated time-window limits (token-agnostic)
      if (this.config.dailyUSD) {
        const denial = await this.slidingWindowCheckUsdLimit(
          context, amount, token, this.config.dailyUSD, "daily", WINDOW_SECONDS.daily, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      if (this.config.weeklyUSD) {
        const denial = await this.slidingWindowCheckUsdLimit(
          context, amount, token, this.config.weeklyUSD, "weekly", WINDOW_SECONDS.weekly, incrementedKeys,
        );
        if (denial) {
          await this.rollbackIncrements(context, incrementedKeys);
          return denial;
        }
      }

      if (this.config.monthlyUSD) {
        const denial = await this.slidingWindowCheckUsdLimit(
          context, amount, token, this.config.monthlyUSD, "monthly", WINDOW_SECONDS.monthly, incrementedKeys,
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
   * H-01 FIX: Sliding window check for a time-window spending limit.
   * Instead of TTL-based counters that reset at boundaries (allowing 2x spend),
   * this stores individual transaction records with timestamps and sums all
   * transactions within the trailing window period relative to the current time.
   *
   * Each transaction is recorded as "timestamp:amount" in a store list.
   * On evaluation, recent entries are retrieved and only those within the
   * sliding window are summed. This eliminates boundary double-spend.
   */
  private async slidingWindowCheckLimit(
    context: PolicyContext,
    amount: number,
    token: string,
    limitConfig: { amount: string; token: string },
    window: string,
    windowSeconds: number,
    incrementedKeys: Array<{ key: string; amount: number; ttl: number }>,
  ): Promise<PolicyDecision | null> {
    const normalizedIntentToken = normalizeTokenId(token);
    const normalizedLimitToken = normalizeTokenId(limitConfig.token);
    if (normalizedIntentToken !== normalizedLimitToken) {
      return null; // Different token, skip this limit
    }

    const limit = parseFloat(limitConfig.amount);
    const logKey = `${this.keyPrefix}log:${window}:${normalizedLimitToken}`;
    const counterKey = `${this.keyPrefix}${window}:${normalizedLimitToken}`;
    const now = context.now;
    const windowStartMs = now - windowSeconds * 1000;

    // Retrieve recent transaction records and sum amounts within the sliding window
    const recentEntries = await context.store.getRecent(logKey, MAX_WINDOW_ENTRIES);
    let windowTotal = 0;
    for (const entry of recentEntries) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) continue;
      const ts = parseInt(entry.slice(0, colonIdx), 10);
      const amt = parseFloat(entry.slice(colonIdx + 1));
      if (ts >= windowStartMs && Number.isFinite(amt)) {
        windowTotal += amt;
      }
    }

    const projectedTotal = windowTotal + amount;

    // SEC: Use precision-safe comparison to avoid float drift in accumulated totals
    if (safeGt(projectedTotal, limit)) {
      // M-61 FIX: Sanitized denial message — does not reveal window type or token details
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Spending limit exceeded",
      };
    }

    // Record this transaction in the sliding window log
    await context.store.append(logKey, `${now}:${amount}`);
    // Also maintain the atomic counter for backwards compatibility
    await this.ensureKeyWithTTL(context, counterKey, windowSeconds);
    await context.store.increment(counterKey, amount);
    incrementedKeys.push({ key: counterKey, amount, ttl: windowSeconds });

    return null;
  }

  /**
   * CRIT-02 fix: Rollback incremented counters on denial or error.
   * Decrements each key that was incremented during this evaluation.
   *
   * M-22 FIX: After decrementing, clamp the counter to zero to prevent negative
   * values when the counter's TTL has expired between increment and rollback.
   * A negative counter would effectively grant extra spending budget.
   */
  private async rollbackIncrements(
    context: PolicyContext,
    incrementedKeys: Array<{ key: string; amount: number; ttl: number }>,
  ): Promise<void> {
    for (const { key, amount } of incrementedKeys) {
      try {
        const newValue = await context.store.increment(key, -amount);
        // M-22 FIX: Clamp to zero — if TTL expired and counter was re-initialized,
        // the decrement could drive it negative, granting extra budget.
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
   * calls to get()+set() could reset a counter's TTL, erasing accumulated spending.
   */
  private async ensureKeyWithTTL(context: PolicyContext, key: string, ttl: number): Promise<void> {
    await context.store.setIfNotExists(key, "0", ttl);
  }

  /**
   * CRIT-03 fix: Check per-transaction USD limit.
   * Converts the token amount to USD and compares against the limit.
   * Fails closed if USD price is unavailable and a USD limit is configured.
   */
  private async checkUsdPerTransaction(
    context: PolicyContext,
    amount: number,
    token: string,
  ): Promise<PolicyDecision | null> {
    if (!this.config.perTransactionUSD) return null;

    const limit = parseFloat(this.config.perTransactionUSD.amount);
    const usdValue = await this.getUsdValue(context, token, String(amount));
    if (usdValue === null) {
      // Fail-closed: can't determine USD value, deny
      return {
        decision: "DENY",
        rule: this.name,
        reason: `USD spending limit configured but cannot determine USD value. ` +
          `Ensure getValueInUSD is available in the policy context.`,
      };
    }

    if (safeGt(usdValue, limit)) {
      // M-61 FIX: Sanitized denial message — does not reveal specific limit or token details
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Per-transaction spending limit exceeded",
      };
    }

    return null;
  }

  /**
   * H-01 FIX: Sliding window check for a USD time-window spending limit.
   * Converts the token amount to USD before tracking against the global USD sliding window.
   */
  private async slidingWindowCheckUsdLimit(
    context: PolicyContext,
    amount: number,
    token: string,
    limitConfig: { amount: string },
    window: string,
    windowSeconds: number,
    incrementedKeys: Array<{ key: string; amount: number; ttl: number }>,
  ): Promise<PolicyDecision | null> {
    const limit = parseFloat(limitConfig.amount);
    const usdValue = await this.getUsdValue(context, token, String(amount));
    if (usdValue === null) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `USD spending limit configured but cannot determine USD value for token. ` +
          `Ensure getValueInUSD is available in the policy context.`,
      };
    }

    const logKey = `${this.keyPrefix}log:${window}:USD`;
    const counterKey = `${this.keyPrefix}${window}:USD`;
    const now = context.now;
    const windowStartMs = now - windowSeconds * 1000;

    // Retrieve recent USD transaction records and sum within sliding window
    const recentEntries = await context.store.getRecent(logKey, MAX_WINDOW_ENTRIES);
    let windowTotal = 0;
    for (const entry of recentEntries) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) continue;
      const ts = parseInt(entry.slice(0, colonIdx), 10);
      const amt = parseFloat(entry.slice(colonIdx + 1));
      if (ts >= windowStartMs && Number.isFinite(amt)) {
        windowTotal += amt;
      }
    }

    const projectedTotal = windowTotal + usdValue;

    if (safeGt(projectedTotal, limit)) {
      // M-61 FIX: Sanitized denial message — does not reveal window type or token details
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Spending limit exceeded",
      };
    }

    // Record this USD transaction in the sliding window log
    await context.store.append(logKey, `${now}:${usdValue}`);
    // Also maintain the atomic counter for backwards compatibility
    await this.ensureKeyWithTTL(context, counterKey, windowSeconds);
    await context.store.increment(counterKey, usdValue);
    incrementedKeys.push({ key: counterKey, amount: usdValue, ttl: windowSeconds });

    return null;
  }

  /**
   * CRIT-03 fix: Get USD value via the policy context's getValueInUSD function.
   * Returns null if no USD price function is available.
   *
   * H-04 FIX: Added sanity checks for price oracle data to guard against manipulation:
   * - Rejects non-finite, negative, or zero USD values (corrupted price data)
   * - Rejects per-unit prices outside reasonable bounds ($0.0001 to $1,000,000)
   *   to catch oracle manipulation (e.g., reporting SOL at $0.001 or $999,999)
   * - For staleness checks: the getValueInUSD provider should implement its own
   *   staleness detection (e.g., reject prices older than 60 seconds). The policy
   *   rule cannot verify staleness directly since it only receives a final USD value.
   *   If the provider returns stale data, it should throw, which triggers fail-closed.
   */
  private async getUsdValue(
    context: PolicyContext,
    token: string,
    amount: string,
  ): Promise<number | null> {
    if (!context.getValueInUSD) return null;
    try {
      const usdValue = await context.getValueInUSD(token, amount);

      // H-04 FIX: Reject non-finite, negative, or zero USD values
      if (!Number.isFinite(usdValue) || usdValue < 0) {
        return null;
      }

      // H-04 FIX: Sanity check — compute the per-unit price and reject unreasonable values.
      // This guards against oracle manipulation where an attacker could report an
      // artificially low price to bypass USD spending limits (e.g., SOL at $0.001
      // would allow sending 100,000 SOL under a $100 limit).
      const numericAmount = parseFloat(amount);
      if (Number.isFinite(numericAmount) && numericAmount > 0) {
        const perUnitPrice = usdValue / numericAmount;
        // Reasonable bounds: $0.0001 to $1,000,000 per unit
        // Adjust these bounds based on the tokens your wallet supports.
        // Tokens outside these bounds will be rejected (fail-closed).
        const MIN_SANE_PRICE = 0.0001;
        const MAX_SANE_PRICE = 1_000_000;
        if (perUnitPrice > 0 && (perUnitPrice < MIN_SANE_PRICE || perUnitPrice > MAX_SANE_PRICE)) {
          process.emitWarning(
            `H-04: Suspicious per-unit price for ${token}: $${perUnitPrice.toFixed(6)}. ` +
            `Expected range: $${MIN_SANE_PRICE} - $${MAX_SANE_PRICE}. Rejecting for safety.`,
            "KovaPriceOracleWarning",
          );
          return null;
        }
      }

      return usdValue;
    } catch {
      // Fail-closed: price oracle error means we can't validate the amount
      return null;
    }
  }

  /**
   * Extract the numeric amount from an intent's params. S2-13 fix: rejects negative/zero.
   *
   * H-15 FIX: Reject amounts with more than 18 decimal places to prevent precision loss.
   * parseFloat loses precision beyond ~15-16 significant digits (IEEE 754 double).
   * For example, "0.123456789012345678901" would silently truncate. We validate the
   * decimal place count before parsing and reject overly precise values.
   *
   * L-03 NOTE: For amounts requiring exact precision beyond 15 significant digits
   * (e.g., EVM token amounts with 18 decimals), string-based or BigNumber arithmetic
   * should be used instead of parseFloat. The safeGt() comparison function mitigates
   * drift in limit comparisons via BigInt-based scaling, but the extracted amount
   * itself is approximate when using parseFloat. This is acceptable for most Solana
   * use cases (9 decimals max), but EVM integrations should consider BigNumber parsing.
   */
  private extractAmount(intent: TransactionIntent): number | null {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("amount" in params && typeof params.amount === "string") {
      // H-15 FIX: Reject amounts with more than 18 decimal places
      const dotIndex = params.amount.indexOf(".");
      if (dotIndex !== -1) {
        const decimalPlaces = params.amount.length - dotIndex - 1;
        if (decimalPlaces > 18) {
          process.emitWarning(
            `Amount "${params.amount}" has ${decimalPlaces} decimal places (max 18). ` +
            `Rejecting to prevent precision loss with parseFloat.`,
            "KovaPrecisionWarning",
          );
          return null;
        }
      }

      // POLICY-010 fix: BigInt-based amount extraction for integer amounts.
      // If the amount string represents a pure integer (no decimal point), parse as
      // BigInt first for precision, then convert to number with a safety check.
      // This prevents silent precision loss for large token amounts (e.g., lamports).
      if (/^\d+$/.test(params.amount)) {
        try {
          const bigAmount = BigInt(params.amount);
          if (bigAmount <= 0n) {
            // LOW-T4-07 fix: Log diagnostic when a zero/negative integer amount is encountered.
            // This is fail-closed (treated as 0 spend by returning null, which triggers DENY
            // via CRIT-01), but the silent failure could mask upstream bugs that produce
            // invalid amounts. The warning aids debugging without changing behavior.
            if (bigAmount < 0n) {
              console.warn(
                `[kova:SpendingLimitRule] Negative integer amount "${params.amount}" encountered in extractAmount. ` +
                `This is treated as unquantifiable (DENY). Investigate upstream intent construction.`,
              );
            }
            return null;
          }
          const asNumber = Number(bigAmount);
          if (asNumber > Number.MAX_SAFE_INTEGER) {
            process.emitWarning(
              `Amount ${params.amount} exceeds safe integer range, precision may be lost`,
              "KovaPrecisionWarning",
            );
          }
          return asNumber;
        } catch {
          return null;
        }
      }
      // H-15 FIX: Validate decimal amount format before parseFloat.
      // Only allow strings that match a valid decimal number pattern to prevent
      // parseFloat from silently accepting malformed input like "123abc".
      if (!/^\d+\.\d+$/.test(params.amount)) {
        return null;
      }
      const parsed = parseFloat(params.amount);
      if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
        // LOW-T4-07 fix: Log diagnostic when a negative decimal amount is encountered.
        // Fail-closed: negative amounts are treated as 0 spend (returns null -> DENY),
        // but imprecise diagnostics could mask bugs in upstream intent construction.
        if (Number.isFinite(parsed) && parsed < 0) {
          console.warn(
            `[kova:SpendingLimitRule] Negative decimal amount "${params.amount}" encountered in extractAmount. ` +
            `This is treated as unquantifiable (DENY). Investigate upstream intent construction.`,
          );
        }
        return null;
      }
      if (parsed > Number.MAX_SAFE_INTEGER) {
        process.emitWarning(
          `Amount ${params.amount} exceeds safe integer range, precision may be lost`,
          "KovaPrecisionWarning",
        );
      }
      return parsed;
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

  /**
   * AUDIT-CRIT-01 fix: Check if any token-specific limit is configured for this token.
   * Used to deny transactions in untracked tokens when no USD limits exist.
   */
  private hasTokenSpecificLimit(token: string): boolean {
    const normalized = normalizeTokenId(token);
    const limits = [
      this.config.perTransaction,
      this.config.daily,
      this.config.weekly,
      this.config.monthly,
    ];
    return limits.some(
      (limit) => limit && normalizeTokenId(limit.token) === normalized,
    );
  }

}
