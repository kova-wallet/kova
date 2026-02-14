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
   * MED-T2-06 fix: Clean up resources held by this adapter.
   * Implementations should release any cached state (DNS entries, connections,
   * timers) that would otherwise persist for the process lifetime.
   * Optional — adapters without held resources can omit this method.
   */
  destroy?(): void;
}
