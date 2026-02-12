/**
 * Audit log types — structured logging of every policy decision and transaction.
 */

import type { TransactionIntent } from "../core/intent.js";
import type { PolicyDecision } from "../policy/types.js";

// Re-export PolicyRuleAudit from its canonical location in policy/types.ts
export type { PolicyRuleAudit } from "../policy/types.js";
import type { PolicyRuleAudit } from "../policy/types.js";

export interface AuditEntry {
  /** Timestamp of the audit entry */
  timestamp: number;
  /** The intent ID */
  intentId: string;
  /** Agent that initiated the request */
  agentId?: string;
  /** The full transaction intent */
  intent: TransactionIntent;
  /** Individual policy rule decisions */
  policyDecisions: PolicyRuleAudit[];
  /** The final decision */
  finalDecision: PolicyDecision;
  /** Transaction result (if submitted to chain) */
  transactionResult?: {
    txId: string;
    status: "confirmed" | "failed";
    blockTime?: number;
  };
  /** SHA-256 hash of this entry (for integrity chain) */
  hash?: string;
  /** Hash of the previous audit entry (for integrity chain) */
  previousHash?: string;
}
