/**
 * Transaction results — structured responses from wallet operations.
 */

export type TransactionStatus = "confirmed" | "failed" | "pending" | "denied";

/**
 * CORE-013 fix: TransactionResult is now a discriminated union keyed on `status`.
 * This enforces at the type level that:
 * - "confirmed" results MUST have a `txId` and CANNOT have an `error`
 * - "denied" and "failed" results CAN have an `error` and CANNOT have a `txId`
 * - "pending" results CANNOT have a `txId` or `error`
 *
 * CORE-013 INVARIANTS:
 * 1. `intentId` is always present and matches the original intent's ID.
 * 2. `timestamp` is always present and represents the wall-clock time (ms since epoch)
 *    when the result was produced. It is NOT the on-chain confirmation timestamp.
 * 3. `summary` is always present and is a sanitized human-readable string (control
 *    characters stripped). It MUST NOT contain raw user input or policy-internal values.
 * 4. For "confirmed" status, `txId` is the on-chain transaction signature/hash. An
 *    empty string indicates the broadcast succeeded but the adapter did not return a
 *    transaction ID (should not happen in normal operation).
 * 5. For "denied" and "failed" status, `error` is optional but when present contains
 *    a sanitized error code and message. The `message` field MUST NOT contain raw
 *    policy limits, RPC URLs, or internal error details (see sanitizePolicyDenialForAgent
 *    and sanitizeTransactionError in wallet.ts).
 * 6. `chainData` is reserved for chain-adapter-specific metadata (e.g., slot number,
 *    block hash) and is not currently populated by the core wallet.
 */
export type TransactionResult =
  | {
      status: "confirmed";
      txId: string;
      summary: string;
      intentId: string;
      timestamp: number;
      error?: never;
      chainData?: Record<string, unknown>;
    }
  | {
      status: "denied";
      summary: string;
      intentId: string;
      timestamp: number;
      error?: TransactionError;
      txId?: never;
      chainData?: Record<string, unknown>;
    }
  | {
      status: "failed";
      summary: string;
      intentId: string;
      timestamp: number;
      error?: TransactionError;
      txId?: never;
      chainData?: Record<string, unknown>;
    }
  | {
      status: "pending";
      summary: string;
      intentId: string;
      timestamp: number;
      error?: never;
      txId?: never;
      chainData?: Record<string, unknown>;
    };

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
  | "SIMULATION_FAILED"
  | "TRANSACTION_FAILED"
  | "SIGNER_ERROR"
  | "CHAIN_ERROR"
  | "STORE_ERROR"
  | "CIRCUIT_BREAKER_OPEN"
  | "WALLET_DRAINING"
  | "AUTH_FAILED"
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
