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
   */
  intentHash?: string;
}

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
   */
  intentHash?: string;
}

export interface ApprovalChannel {
  /** Name of this channel (e.g., "telegram", "slack") */
  readonly name: string;

  /** Send an approval request and wait for a decision */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
