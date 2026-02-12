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
}

export type ApprovalDecision = "approved" | "rejected" | "timeout";

export interface ApprovalResult {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy?: string;
  decidedAt: number;
}

export interface ApprovalChannel {
  /** Name of this channel (e.g., "telegram", "slack") */
  readonly name: string;

  /** Send an approval request and wait for a decision */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
