/**
 * Transaction Intents — high-level, structured descriptions of what an agent wants to accomplish.
 * Agents express *what* they want, not *how* to do it.
 */

export type ChainId = "solana" | "ethereum" | "base" | "system";

export type IntentType = "transfer" | "swap" | "mint" | "stake" | "custom";

export interface TransferParams {
  /** Recipient wallet address */
  to: string;
  /** Human-readable amount (e.g., "1.5") */
  amount: string;
  /** Token symbol (e.g., "SOL", "USDC") or mint address */
  token: string;
}

export interface SwapParams {
  /** Token to sell */
  fromToken: string;
  /** Token to buy */
  toToken: string;
  /** Amount of fromToken to sell (human-readable) */
  amount: string;
  /** Maximum slippage tolerance (e.g., 0.01 for 1%). Defaults to 0.5% */
  maxSlippage?: number;
}

export interface MintParams {
  /** Collection or program address */
  collection: string;
  /** Metadata URI */
  metadataUri: string;
  /** Recipient address (defaults to wallet address) */
  to?: string;
}

export interface StakeParams {
  /** Amount to stake (human-readable) */
  amount: string;
  /** Token to stake */
  token: string;
  /** Validator or pool address */
  validator?: string;
}

export interface CustomParams {
  /** Program or contract address to interact with */
  programId: string;
  /** Instruction data (base64 encoded) */
  data: string;
  /** Accounts involved in the instruction */
  accounts: Array<{
    address: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
}

export type IntentParams = TransferParams | SwapParams | MintParams | StakeParams | CustomParams;

export interface IntentMetadata {
  /** Why the agent wants to perform this action */
  reason?: string;
  /** Identifier for the agent that initiated the request */
  agentId?: string;
  /** Identifier for the task this is part of */
  taskId?: string;
}

/** Common fields shared by all intent variants */
interface TransactionIntentBase {
  /** Unique identifier for this intent (auto-generated if not provided) */
  readonly id?: string;
  /** Target chain */
  readonly chain: ChainId;
  /** Optional metadata for audit and context */
  readonly metadata?: IntentMetadata;
  /** Timestamp when the intent was created */
  readonly createdAt?: number;
}

/**
 * A discriminated union where `type` discriminates `params`.
 * Use type guards (isTransferIntent, isSwapIntent, etc.) for runtime validation
 * of untrusted input — the union provides compile-time narrowing after guards pass.
 */
export type TransactionIntent =
  | (TransactionIntentBase & { readonly type: "transfer"; readonly params: TransferParams })
  | (TransactionIntentBase & { readonly type: "swap"; readonly params: SwapParams })
  | (TransactionIntentBase & { readonly type: "mint"; readonly params: MintParams })
  | (TransactionIntentBase & { readonly type: "stake"; readonly params: StakeParams })
  | (TransactionIntentBase & { readonly type: "custom"; readonly params: CustomParams });

/**
 * Type guard for transfer intents.
 * MED-27 fix: Validates params shape in addition to type string to prevent
 * unsafe property access on malformed intents that have type "transfer"
 * but missing or wrong-typed params fields.
 *
 * MED-18 NOTE: These type guards intentionally do NOT reject extra properties.
 * This is by design (TypeScript structural typing). Extra properties are stripped
 * during sanitizeIntentForAudit to prevent them from leaking into audit logs.
 */
export function isTransferIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { readonly type: "transfer"; readonly params: TransferParams } {
  if (intent.type !== "transfer") return false;
  // Runtime validation for untrusted input (intent.type narrows params to TransferParams at compile time)
  const p = intent.params;
  return (
    typeof p.to === "string" &&
    typeof p.amount === "string" &&
    typeof p.token === "string"
  );
}

/**
 * Type guard for swap intents.
 * MED-27 fix: Validates params shape (fromToken, toToken, amount required).
 */
export function isSwapIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { readonly type: "swap"; readonly params: SwapParams } {
  if (intent.type !== "swap") return false;
  const p = intent.params;
  return (
    typeof p.fromToken === "string" &&
    typeof p.toToken === "string" &&
    typeof p.amount === "string"
  );
}

/**
 * Type guard for mint intents.
 * MED-27 fix: Validates params shape (collection, metadataUri required).
 */
export function isMintIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { readonly type: "mint"; readonly params: MintParams } {
  if (intent.type !== "mint") return false;
  const p = intent.params;
  return (
    typeof p.collection === "string" &&
    typeof p.metadataUri === "string"
  );
}

/**
 * Type guard for stake intents.
 * MED-27 fix: Validates params shape (amount, token required).
 */
export function isStakeIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { readonly type: "stake"; readonly params: StakeParams } {
  if (intent.type !== "stake") return false;
  const p = intent.params;
  return (
    typeof p.amount === "string" &&
    typeof p.token === "string"
  );
}

/**
 * Type guard for custom intents.
 * MED-27 fix: Validates params shape (programId, data, accounts required).
 * M-09 fix: Validates that each element in the accounts array is a valid account
 * object with the required fields (address: string, isSigner: boolean, isWritable: boolean).
 * Without this, malformed account entries (e.g., null, numbers, strings, or objects
 * missing required fields) would pass the type guard and cause runtime errors
 * downstream when accessing account properties.
 */
export function isCustomIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { readonly type: "custom"; readonly params: CustomParams } {
  if (intent.type !== "custom") return false;
  const p = intent.params;
  if (
    typeof p.programId !== "string" ||
    typeof p.data !== "string" ||
    !Array.isArray(p.accounts)
  ) {
    return false;
  }
  // M-09 fix: Validate each account element has the required shape
  for (const account of p.accounts as unknown[]) {
    if (account === null || typeof account !== "object") return false;
    const acc = account as Record<string, unknown>;
    if (
      typeof acc.address !== "string" ||
      typeof acc.isSigner !== "boolean" ||
      typeof acc.isWritable !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}
