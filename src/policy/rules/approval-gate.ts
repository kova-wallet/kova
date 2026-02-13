/**
 * ApprovalGateRule — Requires human approval for transactions above a threshold.
 *
 * Behavior:
 * - If transaction amount is below the threshold → ALLOW
 * - If above threshold and no approval channel configured → DENY (fail closed)
 * - If above threshold and channel available → request approval and wait
 *   - approved → ALLOW
 *   - rejected → DENY
 *   - timeout → DENY
 * - If approval channel throws → DENY (fail closed)
 */

import type { PolicyRule, PolicyDecision, PolicyContext, ApprovalGateConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";
import type { ApprovalRequest } from "../../approval/interface.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

function normalizeTokenId(token: string): string {
  if (token.startsWith("0x") && token.length === 42) return token.toLowerCase();
  if (/^[A-Za-z0-9_]{2,16}$/.test(token)) return token.toUpperCase();
  return token;
}

export class ApprovalGateRule implements PolicyRule {
  readonly name = "approval-gate";
  private readonly config: ApprovalGateConfig;

  constructor(config: ApprovalGateConfig) {
    this.config = config;
  }

  /** Get the approval gate configuration (for policy introspection) */
  getConfig(): Readonly<ApprovalGateConfig> {
    return this.config;
  }

  async evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const amount = this.extractAmount(intent);

    // If intent has no amount (e.g., custom), allow through
    if (amount === null) {
      return { decision: "ALLOW" };
    }

    const token = this.extractToken(intent);

    // Check if amount is above the threshold (token-aware)
    if (normalizeTokenId(token) !== normalizeTokenId(this.config.above.token)) {
      // Different token — this rule doesn't apply
      return { decision: "ALLOW" };
    }

    const threshold = parseFloat(this.config.above.amount);
    if (amount <= threshold) {
      return { decision: "ALLOW" };
    }

    // Amount exceeds threshold — require approval
    if (!context.approval) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Transaction of ${amount} ${token} exceeds approval threshold of ${threshold} ${this.config.above.token}, but no approval channel is configured`,
      };
    }

    // Build and send approval request
    const request = this.buildApprovalRequest(intent, amount, token);

    try {
      const result = await context.approval.requestApproval(request);

      if (result.decision === "approved") {
        return { decision: "ALLOW" };
      }

      if (result.decision === "timeout") {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Approval request timed out for ${amount} ${token} transaction`,
        };
      }

      // rejected
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Transaction of ${amount} ${token} was rejected by approver${result.decidedBy ? ` (${result.decidedBy})` : ""}`,
      };
    } catch {
      // Fail closed on approval channel errors
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Approval channel error: failed to get approval for ${amount} ${token} transaction`,
      };
    }
  }

  /** Build an ApprovalRequest from the intent */
	  private buildApprovalRequest(
	    intent: TransactionIntent,
	    amount: number,
	    token: string,
	  ): ApprovalRequest {
	    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
	    const params = intent.params as unknown as Record<string, unknown>;

	    return {
	      id: crypto.randomUUID(),
	      summary: `${intent.type} ${amount} ${token}`,
	      amount: String(amount),
	      token,
	      target: this.extractTarget(intent),
      reason: typeof params.reason === "string" ? params.reason : intent.metadata?.reason as string | undefined,
      agentId: intent.metadata?.agentId as string | undefined,
      expiresAt: Date.now() + timeoutMs,
    };
  }

  /** Extract the numeric amount from an intent's params. S2-13 fix: rejects negative/zero. */
  private extractAmount(intent: TransactionIntent): number | null {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("amount" in params && typeof params.amount === "string") {
      const parsed = parseFloat(params.amount);
      return (isNaN(parsed) || parsed <= 0) ? null : parsed;
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

  /** Extract the target address from an intent */
  private extractTarget(intent: TransactionIntent): string {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("to" in params && typeof params.to === "string") return params.to;
    if ("programId" in params && typeof params.programId === "string") return params.programId;
    if ("collection" in params && typeof params.collection === "string") return params.collection;
    if ("validator" in params && typeof params.validator === "string") return params.validator;
    return "unknown";
  }
}
