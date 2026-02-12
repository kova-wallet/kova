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

/** Type guard for transfer intents */
export function isTransferIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: TransferParams } {
  return intent.type === "transfer";
}

/** Type guard for swap intents */
export function isSwapIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: SwapParams } {
  return intent.type === "swap";
}

/** Type guard for mint intents */
export function isMintIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: MintParams } {
  return intent.type === "mint";
}

/** Type guard for stake intents */
export function isStakeIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: StakeParams } {
  return intent.type === "stake";
}

/** Type guard for custom intents */
export function isCustomIntent(
  intent: TransactionIntent,
): intent is TransactionIntent & { params: CustomParams } {
  return intent.type === "custom";
}
