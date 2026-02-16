/**
 * Policy types — defines the shape of policy rules and decisions.
 */

import type { TransactionIntent } from "../core/intent.js";
import type { Store } from "../stores/interface.js";
import type { ApprovalChannel } from "../approval/interface.js";

/** The result of evaluating a policy rule against an intent */
export type PolicyDecision = PolicyAllow | PolicyDeny | PolicyPending;

export interface PolicyAllow {
  decision: "ALLOW";
}

export interface PolicyDeny {
  decision: "DENY";
  /** Which rule produced this denial */
  rule: string;
  /** Human-readable explanation */
  reason: string;
}

export interface PolicyPending {
  decision: "PENDING";
  /** Which rule requires approval */
  rule: string;
  /** The approval request ID */
  approvalRequestId: string;
}

/** Context passed to policy rules during evaluation */
export interface PolicyContext {
  /** The store for checking spending counters, rate limits, etc. */
  store: Store;
  /** The approval channel (if configured) */
  approval?: ApprovalChannel;
  /** Current timestamp (injectable for testing) */
  now: number;
  /**
   * CRIT-03 fix: Optional function to get the USD value of a token amount.
   * Provided by the wallet from the chain adapter's getValueInUSD().
   * Enables USD-normalized spending limits that prevent cross-token evasion.
   */
  getValueInUSD?: (token: string, amount: string) => Promise<number>;
}

/**
 * A single policy rule that can evaluate a transaction intent.
 *
 * CONC-20 NOTE — DOUBLE INVOCATION:
 * The PolicyEngine uses two-phase evaluation (H-09/M-01 fix). For ALLOWED
 * transactions, evaluate() is called TWICE per intent: once in Phase 1 (dry-run
 * with DryRunStore) and once in Phase 2 (commit with real store). Custom rule
 * implementations with external side effects (API calls, logging, notifications)
 * should be idempotent or check whether the store is a DryRunStore to avoid
 * duplicate side effects. See security_audit_team9 CONC-20.
 */
export interface PolicyRule {
  /** Unique name for this rule (used in audit logs and error messages) */
  name: string;
  /** Evaluate the intent against this rule */
  evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision>;
}

/** Token amount used in policy configuration */
export interface TokenAmount {
  amount: string;
  token: string;
}

/** USD-denominated spending limit (token-agnostic) */
export interface UsdSpendingLimit {
  /** Maximum USD value (e.g., "100" for $100) */
  amount: string;
}

/** Spending limit configuration */
export interface SpendingLimitConfig {
  perTransaction?: TokenAmount;
  daily?: TokenAmount;
  weekly?: TokenAmount;
  monthly?: TokenAmount;
  /**
   * MED-T4-01 fix: Optional key prefix for scoping spending limit counters.
   * When multiple wallets or agents share the same store, set this to a unique
   * identifier (e.g., wallet address or agent ID) to prevent counter collisions.
   * Defaults to "spending:" for backward compatibility.
   */
  keyPrefix?: string;
  /**
   * CRIT-03 fix: USD-denominated limits that apply across ALL tokens.
   * Prevents cross-token evasion (e.g., swapping SOL to USDC to bypass SOL limits).
   * Requires `getValueInUSD` in PolicyContext to function.
   */
  perTransactionUSD?: UsdSpendingLimit;
  dailyUSD?: UsdSpendingLimit;
  weeklyUSD?: UsdSpendingLimit;
  monthlyUSD?: UsdSpendingLimit;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  maxTransactionsPerMinute?: number;
  maxTransactionsPerHour?: number;
  /**
   * POLICY-007 fix: Optional key prefix for scoping rate limit counters.
   * When multiple wallets or agents share the same store, set this to a unique
   * identifier (e.g., wallet address or agent ID) to prevent counter collisions.
   * Defaults to empty string for backwards compatibility.
   */
  keyPrefix?: string;
}

/** Time window for active hours */
export interface TimeWindow {
  days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  start: string; // "HH:MM" format
  end: string;   // "HH:MM" format
}

/** Active hours configuration */
export interface ActiveHoursConfig {
  timezone: string;
  windows: TimeWindow[];
  /**
   * LOW-T4-01 fix: Policy behavior outside active hours. Both options currently
   * return DENY from TimeWindowRule — "require_approval" does NOT actually gate
   * through the approval system. It only changes the denial reason string.
   *
   * @deprecated "require_approval" behaves identically to "deny". It may be
   * changed in a future version to actually gate through the approval system.
   * For real approval-gated behavior, pair TimeWindowRule with ApprovalGateRule.
   */
  outsideHoursPolicy?: "deny" | "require_approval";
}

/** Approval gate configuration */
export interface ApprovalGateConfig {
  above: TokenAmount;
  /**
   * HIGH-04 fix: USD-denominated approval threshold that applies regardless of token.
   * If set, any transaction exceeding this USD value requires approval,
   * preventing bypass via token mismatch (e.g., using USDC when gate is configured for SOL).
   */
  aboveUSD?: UsdSpendingLimit;
  channel?: "telegram" | "slack" | "custom";
  /** Timeout in milliseconds. Defaults to 300_000 (5 min) */
  timeout?: number;
}

/** Cooldown configuration */
export interface CooldownConfig {
  afterTransactionAbove: TokenAmount;
  waitMinutes: number;
}

/** Per-rule audit data captured during policy evaluation */
export interface PolicyRuleAudit {
  /** Which policy rule was evaluated */
  rule: string;
  /** The result of the evaluation */
  result: "ALLOW" | "DENY" | "PENDING";
  /** Human-readable explanation */
  reason?: string;
  /** Time taken to evaluate this rule */
  evaluationTimeMs: number;
}

/** Full result of PolicyEngine.evaluate() — includes per-rule audit data */
export interface PolicyEvaluationResult {
  /** The final policy decision */
  decision: PolicyDecision;
  /** Per-rule audit trail (one entry per rule evaluated) */
  ruleAudits: PolicyRuleAudit[];
  /** Total wall-clock time for all rule evaluations */
  totalEvaluationTimeMs: number;
}

/** The full serializable policy configuration */
export interface PolicyConfig {
  name: string;
  spendingLimit?: SpendingLimitConfig;
  allowAddresses?: string[];
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
  rateLimit?: RateLimitConfig;
  activeHours?: ActiveHoursConfig;
  approvalGate?: ApprovalGateConfig;
  cooldown?: CooldownConfig;
}
