/**
 * ChainAdapter interface — all chain-specific logic is encapsulated behind this interface.
 * The core SDK knows nothing about specific chains.
 */

import type { TransactionIntent } from "../core/intent.js";
import type { UnsignedTransaction } from "../signers/interface.js";
import type { TokenBalance } from "../core/result.js";

export type ChainTransactionStatus = "confirmed" | "finalized" | "failed" | "not_found";

export interface TransactionStatusResult {
  status: ChainTransactionStatus;
  txId: string;
  blockTime?: number;
  fee?: number;
  error?: string;
}

export interface ChainAdapter {
  /** Chain identifier (e.g., "solana", "ethereum") */
  readonly chain: string;

  /** Get the wallet's balance for a specific token */
  getBalance(address: string, token: string): Promise<TokenBalance>;

  /** Get the current USD value of a token amount (for policy evaluation) */
  getValueInUSD(token: string, amount: string): Promise<number>;

  /** Build an unsigned transaction from a TransactionIntent */
  buildTransaction(
    intent: TransactionIntent,
    signerAddress: string,
  ): Promise<UnsignedTransaction>;

  /** Broadcast a signed transaction to the network. Returns the transaction ID. */
  broadcast(signedTxData: Uint8Array): Promise<string>;

  /** Get the status of a previously submitted transaction */
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;

  /** Validate an address for this chain */
  isValidAddress(address: string): boolean;
}
