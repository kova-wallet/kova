/**
 * Transaction results — structured responses from wallet operations.
 */

export type TransactionStatus = "confirmed" | "failed" | "pending" | "denied";

export interface TransactionResult {
  /** The status of the transaction */
  status: TransactionStatus;
  /** Transaction ID / signature on the blockchain (if submitted) */
  txId?: string;
  /** Human-readable summary of what happened */
  summary: string;
  /** The intent ID this result corresponds to */
  intentId: string;
  /** Timestamp when the result was produced */
  timestamp: number;
  /** Error details if status is "failed" or "denied" */
  error?: TransactionError;
  /** Chain-specific details */
  chainData?: Record<string, unknown>;
}

export interface TransactionError {
  /** Error code for programmatic handling */
  code: TransactionErrorCode;
  /** Human-readable error message */
  message: string;
  /** Which policy rule caused the denial (if applicable) */
  policyRule?: string;
  /** Additional context about the error */
  details?: Record<string, unknown>;
}

export type TransactionErrorCode =
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "SPENDING_LIMIT_EXCEEDED"
  | "ADDRESS_NOT_ALLOWED"
  | "PROGRAM_NOT_ALLOWED"
  | "RATE_LIMIT_EXCEEDED"
  | "OUTSIDE_TIME_WINDOW"
  | "APPROVAL_REJECTED"
  | "APPROVAL_TIMEOUT"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_FAILED"
  | "SIGNER_ERROR"
  | "CHAIN_ERROR"
  | "STORE_ERROR"
  | "CIRCUIT_BREAKER_OPEN"
  | "UNKNOWN_ERROR";

export interface TokenBalance {
  /** Token symbol or identifier */
  token: string;
  /** Human-readable balance amount */
  amount: string;
  /** Number of decimal places for this token */
  decimals: number;
  /** USD value of the balance (if available) */
  usdValue?: number;
}

export interface PolicySummary {
  /** Policy name */
  name: string;
  /** Spending limits in effect (HIGH-09 fix: no used counters exposed) */
  spendingLimits: {
    perTransaction?: { amount: string; token: string };
    daily?: { amount: string; token: string };
    weekly?: { amount: string; token: string };
    monthly?: { amount: string; token: string };
  };
  /** Number of allowlisted addresses */
  allowlistedAddresses: number;
  /** Number of allowlisted programs */
  allowlistedPrograms: number;
  /** Whether human approval is required above a threshold */
  approvalRequired?: { above: { amount: string; token: string } };
  /** Rate limits in effect (HIGH-09 fix: no current counters exposed) */
  rateLimits?: {
    maxPerMinute?: number;
    maxPerHour?: number;
  };
  /** Active hours (if restricted) */
  activeHours?: {
    timezone: string;
    isCurrentlyActive: boolean;
  };
  /** Circuit breaker status (if configured) */
  circuitBreaker?: {
    threshold: number;
    cooldownMs: number;
    isOpen: boolean;
  };
}
