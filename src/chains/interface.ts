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

/** CRIT-02 fix: Result of simulating a transaction before signing */
export interface SimulationResult {
  /** Whether the simulation succeeded (transaction would execute without error) */
  success: boolean;
  /** Estimated fee in the chain's native token (e.g., SOL) */
  estimatedFee?: number;
  /** Error message if simulation failed */
  error?: string;
  /** Logs from the simulated execution (useful for debugging) */
  logs?: string[];
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

  /**
   * CRIT-02 fix: Simulate a transaction before signing to detect failures early.
   * Returns a SimulationResult indicating whether the transaction would succeed.
   * This is called after buildTransaction and before sign to catch on-chain errors
   * (insufficient balance, program errors, etc.) without spending gas/fees.
   */
  simulateTransaction(txData: Uint8Array): Promise<SimulationResult>;

  /**
   * CORE-002 / CHAIN-005 fix: Verify that the signed transaction's message bytes match
   * the original unsigned transaction. Detects if a compromised signer modified the
   * transaction instructions, accounts, or other data during signing.
   * Throws if integrity check fails. No-ops if the chain doesn't support verification.
   */
  verifyTransactionIntegrity?(unsignedTxData: Uint8Array, signedTxData: Uint8Array): void;

  /** Broadcast a signed transaction to the network. Returns the transaction ID. */
  broadcast(signedTxData: Uint8Array): Promise<string>;

  /** Get the status of a previously submitted transaction */
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;

  /** Validate an address for this chain */
  isValidAddress(address: string): boolean;

  /**
   * CRIT-06 fix: Capture a pre-swap balance snapshot for post-swap verification.
   * Call before broadcasting a swap transaction to record the output token balance.
   * Optional — only applicable to chain adapters that support swap verification.
   */
  getPreSwapSnapshot?(ownerAddress: string, outputToken: string): Promise<{
    outputToken: string; preBalance: bigint; snapshotTimestamp: number;
  }>;

  /**
   * CRIT-06 fix: Verify that a swap produced the expected minimum output amount.
   * Call after broadcast + confirmation to detect sandwich attacks and partial fills.
   */
  verifySwapOutput?(
    ownerAddress: string,
    preSwapSnapshot: { outputToken: string; preBalance: bigint; snapshotTimestamp: number },
    minimumExpectedOut: bigint,
    quotedOutAmount?: bigint,
  ): Promise<{
    passed: boolean; actualReceived: bigint; minimumExpected: bigint;
    quotedAmount?: bigint; deficit?: bigint; warning?: string;
  }>;

  /**
   * CRIT-07 fix: Refresh the blockhash on an unsigned transaction.
   * Call after approval delays (which may exceed Solana's ~60-90s blockhash expiry)
   * and before signing to prevent broadcast failures from stale blockhashes.
   */
  refreshBlockhash?(unsignedTx: UnsignedTransaction): Promise<UnsignedTransaction>;

  /**
   * MED-T2-06 fix: Clean up resources held by this adapter.
   * Implementations should release any cached state (DNS entries, connections,
   * timers) that would otherwise persist for the process lifetime.
   * Optional — adapters without held resources can omit this method.
   */
  destroy?(): void;
}
