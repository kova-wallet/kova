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
}

/** A single policy rule that can evaluate a transaction intent */
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

/** Spending limit configuration */
export interface SpendingLimitConfig {
  perTransaction?: TokenAmount;
  daily?: TokenAmount;
  weekly?: TokenAmount;
  monthly?: TokenAmount;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  maxTransactionsPerMinute?: number;
  maxTransactionsPerHour?: number;
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
  outsideHoursPolicy?: "deny" | "require_approval";
}

/** Approval gate configuration */
export interface ApprovalGateConfig {
  above: TokenAmount;
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
