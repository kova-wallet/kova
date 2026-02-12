/**
 * Solana transfer operations — SOL and SPL token transfers.
 *
 * Builds unsigned transactions that the LocalSigner can sign.
 * Serialize with { requireAllSignatures: false } since signing happens separately.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { TransferParams } from "../../core/intent.js";
import type { UnsignedTransaction } from "../../signers/interface.js";
import {
  resolveTokenMint,
  toSmallestUnit,
  getTokenDecimals,
  SolanaAdapterError,
} from "./utils.js";

/**
 * Build an unsigned SOL transfer transaction.
 * Uses SystemProgram.transfer instruction.
 */
export async function buildSOLTransfer(
  connection: Connection,
  params: TransferParams,
  signerAddress: string,
): Promise<UnsignedTransaction> {
  const sender = new PublicKey(signerAddress);
  const recipient = new PublicKey(params.to);
  const lamports = toSmallestUnit(params.amount, 9);

  const transaction = new Transaction();

  // Add priority fee instructions
  await addPriorityFee(connection, transaction, [sender, recipient]);

  // Add the transfer instruction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: sender,
      toPubkey: recipient,
      lamports,
    }),
  );

  // Fetch recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = sender;

  // Serialize without requiring signatures (signer does that later)
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    chain: "solana",
    data: serialized,
    description: `Transfer ${params.amount} SOL to ${params.to}`,
  };
}

/**
 * Build an unsigned SPL token transfer transaction.
 * Automatically creates the recipient's Associated Token Account (ATA) if it doesn't exist.
 */
export async function buildSPLTransfer(
  connection: Connection,
  params: TransferParams,
  signerAddress: string,
  isDevnet: boolean,
): Promise<UnsignedTransaction> {
  const sender = new PublicKey(signerAddress);
  const recipient = new PublicKey(params.to);

  const mint = resolveTokenMint(params.token, isDevnet);
  if (!mint) {
    throw new SolanaAdapterError(
      "INVALID_TOKEN",
      `Unknown token: ${params.token}. Provide a symbol (USDC) or mint address.`,
    );
  }

  const decimals = getTokenDecimals(params.token, isDevnet);
  if (decimals === null) {
    throw new SolanaAdapterError(
      "UNKNOWN_DECIMALS",
      `Cannot determine decimals for token: ${params.token}. Use a known symbol or provide mint address.`,
    );
  }

  const amount = toSmallestUnit(params.amount, decimals);

  // Derive ATAs for both sender and recipient
  const senderATA = getAssociatedTokenAddressSync(mint, sender);
  const recipientATA = getAssociatedTokenAddressSync(mint, recipient);

  const transaction = new Transaction();

  // Add priority fee instructions
  await addPriorityFee(connection, transaction, [sender, senderATA, recipientATA]);

  // Check if recipient ATA exists; if not, add creation instruction
  try {
    await getAccount(connection, recipientATA);
  } catch (err) {
    // Distinguish "account not found" from actual RPC errors
    const isNotFound =
      (err instanceof Error && err.name === "TokenAccountNotFoundError") ||
      (err instanceof Error && err.name === "TokenInvalidAccountOwnerError") ||
      (err instanceof Error && err.message.includes("could not find account"));
    if (!isNotFound) {
      throw new SolanaAdapterError(
        "RPC_ERROR",
        `Failed to check recipient ATA: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ATA doesn't exist — sender pays for creation
    transaction.add(
      createAssociatedTokenAccountInstruction(
        sender,
        recipientATA,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  // Add the transfer instruction
  transaction.add(
    createTransferInstruction(
      senderATA,
      recipientATA,
      sender,
      amount,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = sender;

  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    chain: "solana",
    data: serialized,
    description: `Transfer ${params.amount} ${params.token} to ${params.to}`,
  };
}

/**
 * Add priority fee instructions to a transaction.
 * Queries recent prioritization fees to determine an appropriate fee.
 * Silently no-ops on failure (safe on devnet where fees are negligible).
 */
export async function addPriorityFee(
  connection: Connection,
  transaction: Transaction,
  accounts: PublicKey[],
): Promise<void> {
  try {
    const fees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accounts,
    });

    // Use the median of recent fees, with a minimum floor
    const recentFees = fees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);

    const medianFee =
      recentFees.length > 0
        ? recentFees[Math.floor(recentFees.length / 2)]!
        : 1000; // default 1000 micro-lamports per CU

    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: medianFee,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 200_000,
      }),
    );
  } catch {
    // Fee estimation failure is non-fatal
  }
}
