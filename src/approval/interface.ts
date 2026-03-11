/**
 * ApprovalChannel interface — abstraction over human approval delivery channels.
 */

export interface ApprovalRequest {
  /** Unique identifier for this approval request */
  id: string;
  /** What the agent wants to do (human-readable) */
  summary: string;
  /** Amount in human-readable format */
  amount: string;
  /** Token symbol */
  token: string;
  /** USD value (if available) */
  usdValue?: number;
  /** Recipient or target address */
  target: string;
  /** Agent's stated reason for this transaction */
  reason?: string;
  /** Agent identifier */
  agentId?: string;
  /**
   * AP-01 fix: User ID of the person who initiated/requested this transaction.
   * Used for self-approval prevention — if set, this user cannot also approve the request.
   * The value must be in the same identity space as the approval channel (e.g., Telegram
   * numeric user ID, Slack user ID, email address, etc.).
   */
  requestedByUserId?: string;
  /** Current daily spend vs limit */
  budgetContext?: {
    dailySpent: string;
    dailyLimit: string;
    token: string;
  };
  /** When this request expires */
  expiresAt: number;
  /**
   * HIGH-05 fix: SHA-256 hash of the transaction parameters.
   * Cryptographically binds the approval to the specific transaction, preventing
   * TOCTOU attacks where the intent could theoretically be modified after approval
   * but before execution. The hash is included in the approval message so the
   * approver can verify it matches.
   *
   * REQUIRED: Without this hash, the approval cannot be cryptographically bound to
   * the specific transaction, allowing a modified transaction to reuse an existing
   * approval. Always computed by the ApprovalGateRule before sending approval requests.
   */
  intentHash: string;
}

/**
 * APPR-08 clarification: All three decision types map to policy outcomes as follows:
 * - "approved" → ALLOW (transaction proceeds)
 * - "rejected" → DENY (explicitly rejected by a human approver)
 * - "timeout"  → DENY (fail-closed; no response within the configured timeout window)
 *
 * The "timeout" value is intentionally distinct from "rejected" for audit trail purposes:
 * it indicates that no human responded, as opposed to an explicit rejection. Both result
 * in a DENY decision at the policy engine level (see ApprovalGateRule.evaluate()).
 */
export type ApprovalDecision = "approved" | "rejected" | "timeout";

export interface ApprovalResult {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy?: string;
  decidedAt: number;
  /**
   * HIGH-12 fix: Echo back the intent hash that was approved.
   * The approval gate verifies this matches the original intent to prevent
   * TOCTOU attacks where the intent is modified between approval and execution.
   * Optional for backwards compatibility — if not provided, the approval gate
   * still verifies by re-computing the hash from the original intent.
   */
  intentHash?: string;
}

export interface ApprovalChannel {
  /** Name of this channel (e.g., "webhook", "callback", "telegram") */
  readonly name: string;

  /** Send an approval request and wait for a decision */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
