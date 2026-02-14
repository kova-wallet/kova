/**
 * Transaction Intents — high-level, structured descriptions of what an agent wants to accomplish.
 * Agents express *what* they want, not *how* to do it.
 */

export type ChainId = "solana" | "ethereum" | "base";

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
  /** Urgency level — may influence approval timeout */
  urgency?: "low" | "normal" | "high";
}

export interface TransactionIntent {
  /** Unique identifier for this intent (auto-generated if not provided) */
  id?: string;
  /** The type of operation */
  type: IntentType;
  /** Target chain */
  chain: ChainId;
  /** Operation-specific parameters */
  params: IntentParams;
  /** Optional metadata for audit and context */
  metadata?: IntentMetadata;
  /** Timestamp when the intent was created */
  createdAt?: number;
}

/**
 * Type guard for transfer intents.
 * MED-27 fix: Validates params shape in addition to type string to prevent
 * unsafe property access on malformed intents that have type "transfer"
 * but missing or wrong-typed params fields.
 */
export function isTransferIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: TransferParams } {
  if (intent.type !== "transfer") return false;
  const p = intent.params as unknown as Record<string, unknown>;
  return (
    Object.hasOwn(p, "to") && typeof p.to === "string" &&
    Object.hasOwn(p, "amount") && typeof p.amount === "string" &&
    Object.hasOwn(p, "token") && typeof p.token === "string"
  );
}

/**
 * Type guard for swap intents.
 * MED-27 fix: Validates params shape (fromToken, toToken, amount required).
 */
export function isSwapIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: SwapParams } {
  if (intent.type !== "swap") return false;
  const p = intent.params as unknown as Record<string, unknown>;
  return (
    Object.hasOwn(p, "fromToken") && typeof p.fromToken === "string" &&
    Object.hasOwn(p, "toToken") && typeof p.toToken === "string" &&
    Object.hasOwn(p, "amount") && typeof p.amount === "string"
  );
}

/**
 * Type guard for mint intents.
 * MED-27 fix: Validates params shape (collection, metadataUri required).
 */
export function isMintIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: MintParams } {
  if (intent.type !== "mint") return false;
  const p = intent.params as unknown as Record<string, unknown>;
  return (
    Object.hasOwn(p, "collection") && typeof p.collection === "string" &&
    Object.hasOwn(p, "metadataUri") && typeof p.metadataUri === "string"
  );
}

/**
 * Type guard for stake intents.
 * MED-27 fix: Validates params shape (amount, token required).
 */
export function isStakeIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: StakeParams } {
  if (intent.type !== "stake") return false;
  const p = intent.params as unknown as Record<string, unknown>;
  return (
    Object.hasOwn(p, "amount") && typeof p.amount === "string" &&
    Object.hasOwn(p, "token") && typeof p.token === "string"
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
): intent is TransactionIntent & { params: CustomParams } {
  if (intent.type !== "custom") return false;
  const p = intent.params as unknown as Record<string, unknown>;
  if (
    !(Object.hasOwn(p, "programId") && typeof p.programId === "string") ||
    !(Object.hasOwn(p, "data") && typeof p.data === "string") ||
    !(Object.hasOwn(p, "accounts") && Array.isArray(p.accounts))
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
