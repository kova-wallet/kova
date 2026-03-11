/**
 * Audit log types — structured logging of every policy decision and transaction.
 */

import type { TransactionIntent } from "../core/intent.js";
import type { PolicyDecision } from "../policy/types.js";

// Re-export PolicyRuleAudit from its canonical location in policy/types.ts
export type { PolicyRuleAudit } from "../policy/types.js";
import type { PolicyRuleAudit } from "../policy/types.js";

/**
 * L-02 GDPR NOTE: The `intent` field may contain PII (addresses, amounts, metadata).
 * Operators should configure field-level redaction via `redactedFields` for GDPR compliance.
 * When fields are redacted before storage, list them in `redactedFields` so downstream
 * consumers know which fields were stripped. Example: redactedFields: ['intent.params.to', 'intent.metadata.agentId']
 */
/**
 * MED-17 fix: Validate an AuditEntry's finalDecision shape.
 * Ensures the decision field is a valid enum value to prevent arbitrary shapes
 * from being accepted and stored in the audit log.
 */
export function isValidAuditEntry(e: AuditEntry): boolean {
  if (!e || typeof e !== "object") return false;
  if (typeof e.timestamp !== "number") return false;
  if (typeof e.intentId !== "string") return false;
  if (!e.finalDecision || typeof e.finalDecision !== "object") return false;
  if (!("decision" in e.finalDecision) ||
      typeof e.finalDecision.decision !== "string" ||
      !["ALLOW", "DENY", "PENDING"].includes(e.finalDecision.decision)) {
    return false;
  }
  return true;
}

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
  /** L-02 fix: List of field paths that were redacted before storage (for GDPR compliance) */
  redactedFields?: string[];
  /** L-06 fix: Distributed trace ID for correlating audit entries across services */
  traceId?: string;
  /** L-06 fix: Session ID for correlating audit entries within a single user session */
  sessionId?: string;
  schemaVersion?: number;
}
