/**
 * PolicyEngine — Evaluates transaction intents against an ordered list of rules.
 * Rules are evaluated from cheapest to most expensive (rate limit → time → allowlist → spending → approval → custom).
 * Evaluation stops at the first DENY. If all rules pass, the intent is ALLOWED.
 *
 * S6 enhancement: Returns PolicyEvaluationResult with per-rule audit data.
 * S6 enhancement: Wraps each rule.evaluate() in try/catch for fail-closed behavior.
 */

import { performance } from "node:perf_hooks";
import type { TransactionIntent } from "../core/intent.js";
import type { PolicyRule, PolicyDecision, PolicyContext, PolicyEvaluationResult, PolicyRuleAudit } from "./types.js";
import type { Store } from "../stores/interface.js";
import type { ApprovalChannel } from "../approval/interface.js";

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly store: Store;
  private readonly approval?: ApprovalChannel;

  constructor(rules: PolicyRule[], store: Store, approval?: ApprovalChannel) {
    if (rules.length === 0) {
      throw new Error(
        "PolicyEngine requires at least one rule. An engine with no rules would allow all transactions unconditionally, violating the deny-by-default principle.",
      );
    }
    // MED-06 fix: Freeze a defensive copy to prevent external mutation of the rules array
    this.rules = Object.freeze([...rules]) as PolicyRule[];
    this.store = store;
    this.approval = approval;
  }

  /**
   * Evaluate an intent against all configured rules.
   * Returns PolicyEvaluationResult with per-rule audit data.
   *
   * Each rule evaluation is timed and wrapped in try/catch.
   * A throwing rule produces DENY (fail-closed) with audit trail.
   * Returns the first DENY or PENDING decision, or ALLOW if all rules pass.
   */
  async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyEvaluationResult> {
    const context: PolicyContext = {
      store: this.store,
      approval: this.approval,
      now: now ?? Date.now(),
    };

    const ruleAudits: PolicyRuleAudit[] = [];
    const totalStart = performance.now();

    for (const rule of this.rules) {
      const ruleStart = performance.now();
      let decision: PolicyDecision;

      try {
        decision = await rule.evaluate(intent, context);
      } catch (err) {
        // Fail-closed: rule evaluation error → DENY with audit trail
        const ruleMs = performance.now() - ruleStart;
        const errorMsg = err instanceof Error ? err.message : String(err);
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
            reason: `Rule evaluation error: ${errorMsg}`,
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
        const totalMs = performance.now() - totalStart;
        return {
          decision,
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
