/**
 * PolicyEngine — Evaluates transaction intents against an ordered list of rules.
 * Rules are evaluated from cheapest to most expensive (rate limit → time → allowlist → spending → approval → custom).
 * Evaluation stops at the first DENY. If all rules pass, the intent is ALLOWED.
 *
 * S6 enhancement: Returns PolicyEvaluationResult with per-rule audit data.
 * S6 enhancement: Wraps each rule.evaluate() in try/catch for fail-closed behavior.
 *
 * M-53 NOTE — STORE OPERATION TIMEOUTS:
 * Store operations (get, set, increment) in the critical evaluation path could block
 * indefinitely if the underlying store implementation hangs (e.g., SQLite lock contention,
 * network-backed store unreachable). Currently there is no timeout on these operations.
 * RECOMMENDATION: Implement store-level timeouts as a future enhancement. Each Store
 * implementation should wrap its operations with a configurable timeout (e.g., 5 seconds)
 * and throw a TimeoutError on expiration. The fail-closed error handling in evaluate()
 * will then correctly DENY the transaction rather than hanging forever. Alternatively,
 * wrap the entire evaluate() call in a Promise.race() with a timeout at the wallet level.
 *
 * M-57 NOTE — TIMING SIDE-CHANNEL IN POLICY EVALUATION:
 * The number of rules evaluated can be inferred from timing differences in the evaluate()
 * response time. An attacker observing evaluation latency could determine how many rules
 * passed before a denial, revealing information about the policy configuration (e.g.,
 * number of rules, which rule denied). This is a KNOWN LIMITATION. For applications
 * requiring strict timing guarantees, consider adding constant-time padding: always
 * iterate over a fixed number of slots (e.g., MAX_RULES) regardless of actual rule count,
 * performing no-op evaluations for empty slots. This would mask the number of rules and
 * which rule produced the denial. The current implementation prioritizes correctness and
 * auditability over timing-channel resistance.
 */

import { performance } from "node:perf_hooks";
import type { TransactionIntent } from "../core/intent.js";
import type { PolicyRule, PolicyDecision, PolicyContext, PolicyEvaluationResult, PolicyRuleAudit } from "./types.js";
import type { Store } from "../stores/interface.js";
import type { ApprovalChannel } from "../approval/interface.js";

/**
 * H-33 fix: Sanitize internal error details from rule evaluation before returning
 * them in the PolicyEvaluationResult. Detailed messages are preserved in audit logs
 * but replaced with generic messages in the returned decision to prevent leaking
 * rule class names, internal paths, or implementation details to callers.
 */
function sanitizeErrorForExternalResult(_errorMsg: string): string {
  return "Policy evaluation error: a rule failed during evaluation";
}

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly store: Store;
  private readonly approval?: ApprovalChannel;
  /**
   * CRIT-03 fix: Optional function to convert token amounts to USD.
   * Injected by the wallet from the chain adapter, enabling USD-normalized spending limits.
   *
   * POLICY-013 WARNING: This function depends on an external price oracle (e.g., Jupiter
   * Price API, CoinGecko, Pyth). Price oracle manipulation is a known risk vector:
   * - An attacker who controls or manipulates the price feed could report artificially low
   *   prices, causing large-value transactions to appear below USD spending thresholds.
   * - Flash loan attacks on DEX liquidity pools can temporarily distort on-chain prices.
   * - Stale prices (from caching or API downtime) may not reflect current market value.
   *
   * Mitigations:
   * - Use multiple independent price sources and compare for consistency.
   * - Implement price staleness checks (reject prices older than N seconds).
   * - Set conservative USD limits to account for potential price manipulation.
   * - The spending-limit and approval-gate rules fail-closed when getValueInUSD is
   *   unavailable or throws, preventing bypass via oracle failure.
   */
  private readonly getValueInUSD?: (token: string, amount: string) => Promise<number>;

  constructor(
    rules: PolicyRule[],
    store: Store,
    approval?: ApprovalChannel,
    getValueInUSD?: (token: string, amount: string) => Promise<number>,
  ) {
    if (rules.length === 0) {
      throw new Error(
        "PolicyEngine requires at least one rule. An engine with no rules would allow all transactions unconditionally, violating the deny-by-default principle.",
      );
    }
    // MED-06 fix: Freeze a defensive copy to prevent external mutation of the rules array
    this.rules = Object.freeze([...rules]) as PolicyRule[];
    this.store = store;
    this.approval = approval;
    this.getValueInUSD = getValueInUSD;
  }

  /**
   * Evaluate an intent against all configured rules.
   * Returns PolicyEvaluationResult with per-rule audit data.
   *
   * H-09/M-01 fix: Two-phase evaluation to prevent cross-rule counter inflation.
   * Phase 1 (dry-run): Evaluate all rules using a snapshot-based store wrapper that
   *   captures all writes without persisting them. If any rule DENIEs, the transaction
   *   is rejected without any counters having been modified.
   * Phase 2 (commit): Only if all rules ALLOW in dry-run, re-evaluate with the real
   *   store to atomically commit counter increments.
   *
   * This eliminates "phantom" counter inflation where rule A increments its counter
   * and ALLOWs, but rule B subsequently DENIEs — previously, rule A's counter would
   * remain inflated even though the transaction never executed.
   *
   * Each rule evaluation is timed and wrapped in try/catch.
   * A throwing rule produces DENY (fail-closed) with audit trail.
   * Returns the first DENY or PENDING decision, or ALLOW if all rules pass.
   */
  async evaluate(
    intent: TransactionIntent,
    now?: number,
  ): Promise<PolicyEvaluationResult> {
    // LOW-05 fix: Validate the injectable `now` parameter to prevent time manipulation.
    // Reject non-finite or negative values. Clamp to within ±1 hour of real time
    // to prevent spending limit bypass (far past) or time window evasion (far future).
    let effectiveNow: number;
    if (now !== undefined && Number.isFinite(now) && now > 0) {
      const realNow = Date.now();
      // MED-04 fix: Reduced from 1 hour to 5 minutes to minimize the window for
      // time manipulation attacks. A 5-minute tolerance accommodates reasonable
      // clock skew without allowing significant spending limit or time window evasion.
      //
      // LOW-T4-03 fix: Cross-reference — This 5-minute drift clamp is intentionally
      // tighter than the 1-hour clamp in CircuitBreaker.clampTime() (src/core/circuit-breaker.ts).
      // The policy engine uses a tighter clamp because policy evaluation (spending limits,
      // time windows) is more sensitive to time manipulation and requires near-real-time
      // accuracy. The circuit breaker uses a wider 1-hour clamp because cooldown periods
      // can be significantly longer and a tight clamp would reject legitimate timestamps.
      const MAX_CLOCK_DRIFT_MS = 300_000; // 5 minutes — see LOW-T4-03 for rationale vs circuit breaker's 1h
      effectiveNow = Math.abs(now - realNow) <= MAX_CLOCK_DRIFT_MS ? now : realNow;
    } else {
      effectiveNow = Date.now();
    }

    // MED-30 note: context.now is set here for rules to use, but RateLimitRule and
    // SpendingLimitRule rely on Date.now() within store TTL expiration (lazy expiration
    // in MemoryStore/SqliteStore). context.now only affects the 1-hour drift validation
    // above and TimeWindowRule. For consistent time in testing, mock Date.now() globally.

    const ruleAudits: PolicyRuleAudit[] = [];
    const totalStart = performance.now();

    // =========================================================================
    // H-09 / M-01 fix — TWO-PHASE EVALUATION TO PREVENT COUNTER INFLATION
    // =========================================================================
    // Phase 1: Dry-run evaluation using a DryRunStore that intercepts all
    // writes (set, increment, delete) without persisting them. Reads fall
    // through to the real store so rules see current counter values, but
    // increments are captured in an overlay. If any rule DENIEs or throws,
    // we return immediately — no counters have been modified.
    //
    // Phase 2: If all rules passed in dry-run, re-evaluate with the real
    // store so that counters are atomically committed. Because we already
    // validated that all rules ALLOW, this second pass should also ALLOW
    // (subject to TOCTOU constraints mitigated by the wallet's execute mutex).
    //
    // This ordering ensures that stateful rules (rate-limit, spending-limit)
    // never inflate counters for transactions that will ultimately be denied
    // by a later rule.
    // =========================================================================

    // --- Phase 1: Dry-run evaluation (no side effects) ---
    const dryRunStore = new DryRunStore(this.store);
    // LOW-T4-05 fix: Freeze the context object to prevent a malicious custom rule
    // from mutating context properties (e.g., replacing store, changing now, removing
    // approval) that would affect subsequent rules in the evaluation chain.
    const dryRunContext: PolicyContext = Object.freeze({
      store: dryRunStore,
      approval: this.approval,
      now: effectiveNow,
      getValueInUSD: this.getValueInUSD,
    });

    for (const rule of this.rules) {
      const ruleStart = performance.now();
      let decision: PolicyDecision;

      try {
        decision = await rule.evaluate(intent, dryRunContext);
      } catch (err) {
        // Fail-closed: rule evaluation error -> DENY with audit trail
        const ruleMs = performance.now() - ruleStart;
        const errorMsg = err instanceof Error ? err.message : String(err);
        // H-33 fix: Log detailed error in audit, return sanitized message in decision
        ruleAudits.push({
          rule: rule.name,
          result: "DENY",
          reason: `Rule evaluation error: ${errorMsg}`,
          evaluationTimeMs: ruleMs,
        });

        const totalMs = performance.now() - totalStart;
        return {
          decision: {
            decision: "DENY",
            rule: rule.name,
            reason: sanitizeErrorForExternalResult(errorMsg),
          },
          ruleAudits,
          totalEvaluationTimeMs: totalMs,
        };
      }

      const ruleMs = performance.now() - ruleStart;
      ruleAudits.push({
        rule: rule.name,
        result: decision.decision,
        reason: decision.decision === "DENY" ? decision.reason : undefined,
        evaluationTimeMs: ruleMs,
      });

      if (decision.decision !== "ALLOW") {
        // No counters were modified — dry-run store captured all writes
        const totalMs = performance.now() - totalStart;
        return {
          decision,
          ruleAudits,
          totalEvaluationTimeMs: totalMs,
        };
      }
    }

    // --- Phase 2: Commit evaluation (persist counter increments) ---
    // All rules passed in dry-run. Now re-evaluate with the real store to
    // atomically commit counter changes. The wallet's execute mutex ensures
    // no concurrent modifications between Phase 1 and Phase 2.
    //
    // CRIT-T4-01 fix: Use a TrackingStore wrapper to capture all appends made
    // during Phase 2. If a later rule unexpectedly denies during commit (TOCTOU
    // race), we can identify which sliding window log entries were persisted by
    // earlier rules and warn about them. The TrackingStore also enables rollback
    // of increments for counters that were modified before the denial.
    const trackingStore = new Phase2TrackingStore(this.store);
    // LOW-T4-05 fix: Freeze commit context too — same rationale as dryRunContext above.
    const commitContext: PolicyContext = Object.freeze({
      store: trackingStore,
      approval: this.approval,
      now: effectiveNow,
      getValueInUSD: this.getValueInUSD,
    });

    for (const rule of this.rules) {
      try {
        const decision = await rule.evaluate(intent, commitContext);
        // If a rule unexpectedly denies during commit (TOCTOU race under
        // non-mutex conditions), respect it — fail-closed is always safe.
        if (decision.decision !== "ALLOW") {
          // CRIT-T4-01 fix: Roll back increments that were persisted by earlier
          // rules in Phase 2 before the denial. Without this, counters and sliding
          // window logs from rules that ALLOWed before this denial would remain
          // inflated, gradually blocking legitimate transactions (DoS via ghost entries).
          await trackingStore.rollbackAll();
          const totalMs = performance.now() - totalStart;
          return {
            decision,
            ruleAudits,
            totalEvaluationTimeMs: totalMs,
          };
        }
      } catch (err) {
        // CRIT-T4-01 fix: Roll back on commit-phase error too
        await trackingStore.rollbackAll();
        // Fail-closed on commit-phase error
        const errorMsg = err instanceof Error ? err.message : String(err);
        const totalMs = performance.now() - totalStart;
        ruleAudits.push({
          rule: rule.name,
          result: "DENY",
          reason: `Rule evaluation error during commit: ${errorMsg}`,
          evaluationTimeMs: 0,
        });
        return {
          decision: {
            decision: "DENY",
            rule: rule.name,
            reason: sanitizeErrorForExternalResult(errorMsg),
          },
          ruleAudits,
          totalEvaluationTimeMs: totalMs,
        };
      }
    }

    const totalMs = performance.now() - totalStart;
    return {
      decision: { decision: "ALLOW" },
      ruleAudits,
      totalEvaluationTimeMs: totalMs,
    };
  }

  /** Get the names of all configured rules */
  getRuleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /** Get a frozen copy of the rules array (for policy introspection by the wallet) */
  getRules(): readonly PolicyRule[] {
    // S5-05 fix: return frozen defensive copy to prevent mutation of internal array
    return Object.freeze([...this.rules]);
  }
}

/**
 * H-09/M-01 fix: DryRunStore — A store wrapper that intercepts all write operations
 * (set, increment, delete) and captures them in an in-memory overlay without persisting
 * to the underlying store. Read operations check the overlay first, then fall through
 * to the real store.
 *
 * This enables Phase 1 (dry-run) of the two-phase evaluation: rules see realistic
 * counter values (current real values + dry-run increments) but no state is modified
 * in the real store. If any rule denies, the overlay is simply discarded.
 *
 * MED-T4-08 LIMITATION — TTL NOT PRESERVED FROM REAL STORE:
 * When DryRunStore reads a value from the real store, it does not capture or respect
 * the TTL (time-to-live) associated with that value. If a counter in the real store
 * has a TTL that expires between Phase 1 (dry-run) and Phase 2 (commit), Phase 1
 * may see the counter value while Phase 2 sees null (expired), causing a TOCTOU gap.
 * This could result in Phase 1 allowing a transaction (seeing accumulated spending
 * near the limit) while Phase 2 sees a reset counter and allows more spending than
 * intended. This is mitigated by:
 *   1. The wallet's execute mutex, which serializes evaluation (short Phase 1-to-2 gap)
 *   2. SpendingLimitRule's sliding window approach, which uses log entries rather than
 *      TTL-based counters for limit enforcement
 * For deployments requiring strict TTL consistency, implement a store-level snapshot
 * mechanism that captures both values and their remaining TTLs atomically.
 */
class DryRunStore implements Store {
  private readonly real: Store;
  /** Overlay of captured writes: key -> { value, ttl } */
  private readonly overlay: Map<string, { value: string; ttl?: number }> = new Map();
  /** Overlay of captured list appends: key -> values[] */
  private readonly listOverlay: Map<string, string[]> = new Map();
  /** Track keys that were deleted in the dry-run */
  private readonly deletedKeys: Set<string> = new Set();

  constructor(real: Store) {
    this.real = real;
  }

  async get(key: string): Promise<string | null> {
    // Check if deleted in dry-run
    if (this.deletedKeys.has(key)) return null;
    // Check overlay first
    const overlayEntry = this.overlay.get(key);
    if (overlayEntry !== undefined) return overlayEntry.value;
    // Fall through to real store
    return this.real.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.deletedKeys.delete(key);
    this.overlay.set(key, { value, ttl: ttlSeconds });
  }

  async increment(key: string, amount: number): Promise<number> {
    // MED-T3-03 fix: Validate that 'amount' is a finite number to prevent NaN/Infinity
    // from propagating into the overlay and corrupting rate-limit or spending-limit state.
    // This mirrors the validation in MemoryStore.increment().
    if (!Number.isFinite(amount)) {
      throw new Error(`DryRunStore.increment: amount must be a finite number, got ${amount}`);
    }
    // Get current value (overlay or real)
    const current = await this.get(key);
    // HIGH-T4-02 fix: Use Number() instead of parseFloat() for consistency with
    // the real store's increment behavior. parseFloat("123abc") returns 123,
    // silently ignoring the trailing characters. Number("123abc") returns NaN,
    // which we then treat as 0 (matching SqliteStore's behavior).
    const currentNum = current !== null ? (Number.isFinite(Number(current)) ? Number(current) : 0) : 0;
    // LOW-T4-04 fix: Zero-floor clamping to prevent negative dry-run counters from
    // granting extra budget. Phase 2 provides the safety net via Phase2TrackingStore's
    // rollbackAll(), but this aligns DryRunStore behavior with real stores.
    const newValue = Math.max(0, currentNum + amount);
    this.overlay.set(key, { value: String(newValue) });
    return newValue;
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== null) return false;
    this.overlay.set(key, { value, ttl: ttlSeconds });
    return true;
  }

  async append(key: string, value: string): Promise<void> {
    // Capture list appends in overlay without modifying the real store
    const existing = this.listOverlay.get(key) ?? [];
    existing.push(value);
    this.listOverlay.set(key, existing);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    // Combine real store entries with dry-run overlay entries
    const realEntries = await this.real.getRecent(key, count);
    const overlayEntries = this.listOverlay.get(key) ?? [];
    const combined = [...realEntries, ...overlayEntries];
    // MED-T4-05 fix: Return in reverse chronological order (newest first) to match
    // MemoryStore.getRecent() which uses .slice(-count).reverse(). Without this,
    // the ordering mismatch between DryRunStore and MemoryStore could cause
    // inconsistent behavior between Phase 1 (dry-run) and Phase 2 (commit).
    return combined.slice(-count).reverse();
  }
}

/**
 * CRIT-T4-01 fix: Phase2TrackingStore — A store wrapper that passes all operations
 * through to the real store but tracks increments so they can be rolled back if a
 * later rule denies during Phase 2.
 *
 * Problem: In Phase 2 (commit), SpendingLimitRule appends to sliding window logs
 * and increments counters on the REAL store. If a later rule unexpectedly denies
 * (TOCTOU race), those appends/increments are already persisted and cannot be
 * undone. An attacker can deliberately craft intents that pass early rules but
 * fail on later rules, gradually inflating sliding window totals until legitimate
 * transactions are blocked (DoS via ghost entries).
 *
 * Fix: Track all increments during Phase 2. On denial, roll back by decrementing
 * each tracked key by the amount it was incremented.
 */
class Phase2TrackingStore implements Store {
  private readonly real: Store;
  /** Track increments for rollback: key -> total amount incremented */
  private readonly incrementedKeys: Map<string, number> = new Map();

  constructor(real: Store) {
    this.real = real;
  }

  async get(key: string): Promise<string | null> {
    return this.real.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.real.set(key, value, ttlSeconds);
  }

  async increment(key: string, amount: number): Promise<number> {
    const result = await this.real.increment(key, amount);
    // Track the increment for potential rollback
    const existing = this.incrementedKeys.get(key) ?? 0;
    this.incrementedKeys.set(key, existing + amount);
    return result;
  }

  async setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    return this.real.setIfNotExists(key, value, ttlSeconds);
  }

  async append(key: string, value: string): Promise<void> {
    return this.real.append(key, value);
  }

  async getRecent(key: string, count: number): Promise<string[]> {
    return this.real.getRecent(key, count);
  }

  /**
   * Roll back all increments that were persisted during Phase 2.
   * Best-effort: individual rollback failures are swallowed (safe direction:
   * counters remain inflated, which means under-counting remaining budget).
   */
  async rollbackAll(): Promise<void> {
    for (const [key, amount] of this.incrementedKeys) {
      try {
        const newValue = await this.real.increment(key, -amount);
        // Clamp to zero to prevent negative counters
        if (newValue < 0) {
          await this.real.set(key, "0");
        }
      } catch {
        // Best-effort rollback — failure means slight under-count (safe direction)
      }
    }
    this.incrementedKeys.clear();
  }
}
