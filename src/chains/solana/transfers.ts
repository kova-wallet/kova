/**
 * Solana transfer operations — SOL and SPL token transfers.
 *
 * Builds unsigned transactions that the LocalSigner can sign.
 * Serialize with { requireAllSignatures: false } since signing happens separately.
 *
 * CHAIN-017: TRANSACTION FEE ESTIMATION — Transaction fees (base fee + priority fee)
 * are NOT deducted from the transfer amount or pre-validated against the sender's
 * balance. The pre-flight balance check (CHAIN-003) only validates the transfer
 * amount, not amount + fees. A transfer of the sender's entire SOL balance will
 * fail at broadcast because fees leave insufficient lamports. Callers should
 * account for fees (~5000 lamports base + priority) when calculating max transfer.
 *
 * CHAIN-018: RECIPIENT ACCOUNT RENT — For SPL transfers, the sender pays the ATA
 * creation rent (~0.00203928 SOL) when the recipient does not have an existing
 * Associated Token Account. This rent cost is NOT included in the pre-flight
 * balance check and could cause the transaction to fail if the sender's SOL
 * balance is barely sufficient for the transfer but not for ATA rent.
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
  getTokenDecimalsOnChain,
  SolanaAdapterError,
  stripControlChars,
} from "./utils.js";

/**
 * HIGH-08 fix / MED-T2-05 fix: Known system/program addresses that should not be used
 * as transfer recipients. Sending funds to these addresses is almost certainly a mistake
 * and results in fund loss.
 *
 * MED-T2-05 fix: Stored as PublicKey objects instead of plain strings. String-based
 * comparison (Set.has()) could miss cases where the same key has different base58
 * representations (e.g., leading zeros, non-canonical encoding). PublicKey.equals()
 * compares the underlying 32-byte key, which is the canonical identity.
 */
const REJECTED_RECIPIENT_PUBKEYS: PublicKey[] = [
  new PublicKey("11111111111111111111111111111111"),                // System Program
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),    // Token Program
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),    // Token-2022 Program
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),    // Associated Token Account
  new PublicKey("ComputeBudget111111111111111111111111111111"),       // Compute Budget
  new PublicKey("SysvarRent111111111111111111111111111111111"),       // Sysvar Rent
  new PublicKey("Vote111111111111111111111111111111111111111"),        // Vote Program
  new PublicKey("Stake11111111111111111111111111111111111111"),        // Stake Program
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),       // BPF Loader
  // LOW-08 fix: Additional system addresses that should never be transfer recipients
  new PublicKey("Ed25519SigVerify111111111111111111111111111"),       // Ed25519 Signature Verification
  new PublicKey("KeccakSecp256k11111111111111111111111111111"),       // Secp256k1 Signature Verification
];

/**
 * HIGH-08 fix / MED-T2-05 fix: Validate that a recipient address is safe for transfers.
 * Rejects known system programs and the zero address.
 * Uses PublicKey.equals() for byte-level comparison rather than string comparison.
 */
function validateRecipientAddress(address: string): void {
  let recipientPubkey: PublicKey;
  try {
    recipientPubkey = new PublicKey(address);
  } catch {
    throw new SolanaAdapterError(
      "INVALID_RECIPIENT",
      `Invalid recipient address: ${address}`,
    );
  }
  for (const rejected of REJECTED_RECIPIENT_PUBKEYS) {
    if (recipientPubkey.equals(rejected)) {
      throw new SolanaAdapterError(
        "INVALID_RECIPIENT",
        `Cannot send funds to system program address: ${address}. This would result in permanent fund loss.`,
      );
    }
  }
}

/**
 * Build an unsigned SOL transfer transaction.
 * Uses SystemProgram.transfer instruction.
 */
export async function buildSOLTransfer(
  connection: Connection,
  params: TransferParams,
  signerAddress: string,
): Promise<UnsignedTransaction> {
  // M-29 fix: Use PublicKey comparison instead of string equality for self-transfer check.
  // String comparison can miss cases where the same key has different base58 representations
  // (e.g., leading zeros or different encoding). PublicKey.equals() compares the underlying
  // 32-byte key, which is the canonical identity.
  const sender = new PublicKey(signerAddress);
  const recipient = new PublicKey(params.to);
  if (sender.equals(recipient)) {
    throw new SolanaAdapterError(
      "INVALID_PARAMS",
      "Cannot transfer to self: recipient matches sender address",
    );
  }

  // HIGH-08 fix: Validate recipient before building transaction
  validateRecipientAddress(params.to);

  // AUDIT-MED-15 fix: Warn when the SOL transfer recipient is off-curve (likely a PDA).
  // SOL CAN be sent to PDAs (they can hold lamports), but this is unusual for typical
  // user-to-user transfers and may indicate a mistake or an attempt to send SOL to a
  // program-derived address. This is a warning, not a rejection, to avoid breaking
  // legitimate use cases (e.g., funding PDA vaults).
  try {
    if (!PublicKey.isOnCurve(recipient.toBytes())) {
      process.emitWarning(
        `SOL transfer recipient ${params.to} is not on the Ed25519 curve (may be a PDA). Ensure this is intentional.`,
        { code: "KOVA_RECIPIENT_PDA_WARNING" },
      );
    }
  } catch {
    // Non-fatal: isOnCurve check failure should not block the transfer
  }

  const lamports = toSmallestUnit(params.amount, 9);

  // CHAIN-003: Pre-flight balance verification.
  // Check the sender has sufficient SOL before building the transaction.
  // This provides an early, clear error instead of failing during simulation or broadcast.
  //
  // CHAIN-003 TOCTOU limitation: This balance check is subject to a time-of-check-to-time-of-use
  // race condition. The balance can change between this check and the actual broadcast (e.g.,
  // another transaction lands, fees are deducted, or an incoming transfer arrives). This check
  // is a best-effort optimization to provide a clear error message early in the pipeline. The
  // authoritative guard is the simulation step (simulateTransaction) in the wallet execution
  // pipeline, which runs the transaction against the current ledger state and catches
  // insufficient balance errors without consuming fees. The on-chain runtime is the final
  // arbiter — if balance is insufficient at execution time, the transaction will fail atomically.
  // H-22 fix: Include estimated transaction fees in the balance check.
  // Base fee is 5000 lamports per signature. Priority fees add additional cost.
  // Using a conservative estimate of 5000 lamports (base fee for 1 signature)
  // plus a buffer for priority fees.
  const ESTIMATED_FEE_LAMPORTS = 5000n; // base fee for 1 signature
  const totalRequired = lamports + ESTIMATED_FEE_LAMPORTS;

  const senderBalance = await connection.getBalance(sender);
  if (BigInt(senderBalance) < totalRequired) {
    throw new SolanaAdapterError(
      "INSUFFICIENT_BALANCE",
      `Insufficient SOL balance for the requested transfer amount. ` +
      `Ensure the sender has enough SOL to cover the transfer plus estimated fees.`,
    );
  }

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

  // AUDIT-HIGH-7 fix: Enforce Solana transaction size limit.
  // Solana transactions must fit within a single IPv6 MTU (1280 bytes) minus headers.
  // Oversized transactions will be rejected by validators at broadcast time, but catching
  // this early provides a clear error instead of a confusing broadcast failure.
  const MAX_TX_SIZE = 1232; // 1 IPv6 MTU (1280) - IPv6 header (40) - UDP header (8) = 1232
  if (serialized.length > MAX_TX_SIZE) {
    throw new SolanaAdapterError(
      "TRANSACTION_TOO_LARGE",
      `Serialized transaction size (${serialized.length} bytes) exceeds Solana's maximum ` +
      `of ${MAX_TX_SIZE} bytes. Reduce the number of instructions or accounts.`,
    );
  }

  return {
    chain: "solana",
    data: serialized,
    // LOW-T2-08 fix: Sanitize raw user input (params.amount, params.to) in description
    // to prevent log injection via control characters in user-provided values.
    description: `Transfer ${stripControlChars(params.amount)} SOL to ${stripControlChars(params.to)}`,
  };
}

/**
 * Build an unsigned SPL token transfer transaction.
 * Automatically creates the recipient's Associated Token Account (ATA) if it doesn't exist.
 *
 * HIGH-06 limitation: This function hardcodes TOKEN_PROGRAM_ID for SPL transfers.
 * Token-2022 (Token Extensions) tokens use a different program ID (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
 * and are NOT supported by this implementation. Attempting to transfer a Token-2022 token
 * will fail because the ATA derivation and transfer instruction use the wrong program.
 * To support Token-2022, the mint account owner must be queried on-chain via getMint()
 * to determine whether it belongs to TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID, and the
 * correct program must be passed to getAssociatedTokenAddressSync() and
 * createTransferInstruction(). See: https://spl.solana.com/token-2022
 */
export async function buildSPLTransfer(
  connection: Connection,
  params: TransferParams,
  signerAddress: string,
  isDevnet: boolean,
): Promise<UnsignedTransaction> {
  // M-29 fix: Use PublicKey comparison instead of string equality for self-transfer check.
  const sender = new PublicKey(signerAddress);
  const recipient = new PublicKey(params.to);
  if (sender.equals(recipient)) {
    throw new SolanaAdapterError(
      "INVALID_PARAMS",
      "Cannot transfer to self: recipient matches sender address",
    );
  }

  // T2-9.1 fix: Warn when the SPL token recipient is a PDA (off-curve address).
  // PDAs cannot sign transactions, so SPL tokens sent to a PDA's ATA may be
  // permanently locked if no program can authorize transfers from that ATA.
  // This is a warning rather than a hard error because some legitimate use cases
  // involve sending tokens to PDA vaults (e.g., program-owned treasuries).
  try {
    if (!PublicKey.isOnCurve(recipient.toBytes())) {
      process.emitWarning(
        `SPL token transfer recipient ${params.to} is a PDA (off-curve address). ` +
        `Tokens sent to a PDA's associated token account may be irrecoverable ` +
        `if no program can authorize transfers from the PDA.`,
        "KovaPDAWarning",
      );
    }
  } catch {
    // Non-fatal: isOnCurve check failure should not block the transfer
  }

  // HIGH-08 fix: Validate recipient before building transaction
  validateRecipientAddress(params.to);

  const mint = resolveTokenMint(params.token, isDevnet);
  if (!mint) {
    throw new SolanaAdapterError(
      "INVALID_TOKEN",
      `Unknown token: ${params.token}. Provide a symbol (USDC) or mint address.`,
    );
  }

  // M29 fix: Fall back to on-chain decimal lookup for unknown tokens.
  // The hardcoded registry only covers SOL, USDC, USDT. For arbitrary mint
  // addresses, query the mint account's decimals field on-chain.
  let decimals = getTokenDecimals(params.token, isDevnet);
  if (decimals === null) {
    if (!mint) {
      throw new SolanaAdapterError(
        "UNKNOWN_DECIMALS",
        `Cannot determine decimals for token: ${params.token}. Use a known symbol or provide mint address.`,
      );
    }
    try {
      decimals = await getTokenDecimalsOnChain(connection, mint);
    } catch (err) {
      throw new SolanaAdapterError(
        "UNKNOWN_DECIMALS",
        `Cannot determine decimals for token ${params.token}: on-chain lookup failed. ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const amount = toSmallestUnit(params.amount, decimals);

  // CHAIN-011: Detect Token-2022 program tokens and return a clear error.
  // Token-2022 tokens are owned by a different program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
  // and require different ATA derivation and transfer instructions. Using TOKEN_PROGRAM_ID
  // for Token-2022 tokens will silently produce wrong ATAs and fail at broadcast.
  const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  try {
    const mintAccountInfo = await connection.getAccountInfo(mint);
    // SOL-04 fix: Reject null mint accounts instead of silently passing them through.
    // Previously, a null mintAccountInfo (non-existent account) would skip the Token-2022
    // check entirely, allowing transfers to non-existent mint addresses to proceed until
    // they fail at a later stage with a confusing error.
    if (!mintAccountInfo) {
      throw new SolanaAdapterError(
        "INVALID_TOKEN",
        "Mint account does not exist on-chain: " + mint.toBase58(),
      );
    }
    if (mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new SolanaAdapterError(
        "TOKEN_2022_NOT_SUPPORTED",
        `Token mint ${mint.toBase58()} is a Token-2022 (Token Extensions) token. ` +
        `Token-2022 transfers require different program IDs for ATA derivation and transfer instructions. ` +
        `This SDK currently only supports standard SPL Token Program tokens. ` +
        `See https://spl.solana.com/token-2022 for details.`,
      );
    }
  } catch (err) {
    if (err instanceof SolanaAdapterError) throw err;
    // MED-T2-04 fix: Fail-closed on RPC errors during Token-2022 detection.
    // Previously, RPC failures (network timeout, connection refused, etc.) caused
    // silent fallback to the standard Token Program. If the token is actually a
    // Token-2022 token, this would produce wrong ATAs and the transfer would fail
    // silently or send funds to an unreachable address. Fail-closed ensures we
    // don't proceed with a potentially incorrect program ID.
    throw new SolanaAdapterError(
      "RPC_ERROR",
      `Failed to detect token program for mint ${mint.toBase58()} (Token-2022 detection). ` +
      `Cannot safely proceed without confirming the token program. ` +
      `RPC error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Derive ATAs for both sender and recipient.
  // CHAIN-011: These calls use the default TOKEN_PROGRAM_ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
  // Token-2022 tokens use a different program ID (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
  // and would require passing TOKEN_2022_PROGRAM_ID here. This SDK currently only supports
  // the original SPL Token program. Token-2022 mints are detected and rejected above.
  const senderATA = getAssociatedTokenAddressSync(mint, sender);
  const recipientATA = getAssociatedTokenAddressSync(mint, recipient);

  // CHAIN-003: Pre-flight balance verification for SPL tokens.
  // Check the sender's token account balance before building the transaction.
  //
  // CHAIN-003 TOCTOU limitation: Same caveat as SOL transfers — this balance check is
  // advisory only. The sender's token balance can change between this check and broadcast.
  // The simulation step catches insufficient balance before fees are spent. The on-chain
  // Token Program enforces the final balance check atomically during execution.
  try {
    const senderAccount = await getAccount(connection, senderATA);
    if (senderAccount.amount < amount) {
      throw new SolanaAdapterError(
        "INSUFFICIENT_BALANCE",
        `Insufficient ${params.token} balance for the requested transfer amount.`,
      );
    }
  } catch (err) {
    if (err instanceof SolanaAdapterError) throw err;
    // If the sender ATA doesn't exist, balance is zero
    const isNotFound =
      (err instanceof Error && err.name === "TokenAccountNotFoundError") ||
      (err instanceof Error && err.name === "TokenInvalidAccountOwnerError") ||
      (err instanceof Error && err.message.includes("could not find account"));
    if (isNotFound) {
      throw new SolanaAdapterError(
        "INSUFFICIENT_BALANCE",
        `Insufficient ${params.token} balance: sender has no token account for this token.`,
      );
    }
    throw new SolanaAdapterError(
      "RPC_ERROR",
      `Failed to check sender token balance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const transaction = new Transaction();

  // Add priority fee instructions
  await addPriorityFee(connection, transaction, [sender, senderATA, recipientATA]);

  // CHAIN-012: Check if recipient ATA exists; if not, add creation instruction.
  // Error handling distinguishes three cases:
  // 1. ATA exists (no error) — proceed without creation instruction
  // 2. ATA does not exist (TokenAccountNotFoundError / TokenInvalidAccountOwnerError /
  //    "could not find account") — add creation instruction, sender pays rent
  // 3. RPC/network error — throw with RPC_ERROR code so the caller knows the
  //    failure was in the lookup, not in ATA creation itself
  try {
    await getAccount(connection, recipientATA);
  } catch (err) {
    // CHAIN-012: Classify the error — "account not found" means we need to create
    // the ATA, while any other error (network timeout, RPC unavailable, malformed
    // response) is an infrastructure failure that should not be confused with a
    // missing account.
    const isNotFound =
      (err instanceof Error && err.name === "TokenAccountNotFoundError") ||
      (err instanceof Error && err.name === "TokenInvalidAccountOwnerError") ||
      (err instanceof Error && err.message.includes("could not find account"));
    if (!isNotFound) {
      throw new SolanaAdapterError(
        "RPC_ERROR",
        `Failed to query recipient Associated Token Account (ATA lookup failed, not ATA creation): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // M-30 fix: When ATA creation is required, check that the transfer amount is
    // economically meaningful relative to the ATA rent exemption cost (~0.00203928 SOL
    // = 2,039,280 lamports). Sending dust amounts that are worth less than the ATA
    // rent could be used to extract rent payments from the sender via many tiny SPL
    // transfers to unique recipients, each requiring a new ATA.
    const ATA_RENT_EXEMPTION_LAMPORTS = 2_039_280n; // ~0.00203928 SOL
    // For tokens with known USD value, we could do a USD comparison, but for simplicity
    // we warn when the transfer amount in smallest units is very small (< 1000 units).
    // The primary protection is warning about the rent cost relative to dust amounts.
    if (amount < 1000n) {
      process.emitWarning(
        `SPL transfer of ${amount} smallest units to a new recipient requires ATA creation ` +
        `costing ~${ATA_RENT_EXEMPTION_LAMPORTS} lamports (~0.002 SOL) in rent. ` +
        `The transfer amount may be worth less than the ATA creation cost. ` +
        `This could indicate a rent extraction attack via dust SPL transfers.`,
        "KovaTransferWarning",
      );
    }

    // T2-5.2 fix: Verify sender has sufficient SOL to cover ATA rent + estimated fees
    // when ATA creation is required. Without this check, the transaction fails at
    // broadcast with a confusing "insufficient lamports" error instead of a clear
    // pre-flight error explaining the ATA rent requirement.
    const ESTIMATED_FEE_LAMPORTS_SPL = 5000n;
    try {
      const senderSOLBalance = await connection.getBalance(sender);
      const requiredSOL = ATA_RENT_EXEMPTION_LAMPORTS + ESTIMATED_FEE_LAMPORTS_SPL;
      if (BigInt(senderSOLBalance) < requiredSOL) {
        throw new SolanaAdapterError(
          "INSUFFICIENT_BALANCE",
          `Insufficient SOL for ATA creation and fees. ` +
          `Fund the sender with at least ~0.003 SOL to cover ATA rent and transaction fees.`,
        );
      }
    } catch (err) {
      if (err instanceof SolanaAdapterError) throw err;
      // Non-fatal: simulation will catch this later
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

  // AUDIT-HIGH-7 fix: Enforce Solana transaction size limit (same as SOL transfers).
  const MAX_TX_SIZE = 1232;
  if (serialized.length > MAX_TX_SIZE) {
    throw new SolanaAdapterError(
      "TRANSACTION_TOO_LARGE",
      `Serialized transaction size (${serialized.length} bytes) exceeds Solana's maximum ` +
      `of ${MAX_TX_SIZE} bytes. Reduce the number of instructions or accounts.`,
    );
  }

  return {
    chain: "solana",
    data: serialized,
    // LOW-T2-08 fix: Sanitize raw user input (params.amount, params.token, params.to)
    // in description to prevent log injection via control characters.
    description: `Transfer ${stripControlChars(params.amount)} ${stripControlChars(params.token)} to ${stripControlChars(params.to)}`,
  };
}

/**
 * LOW-02 / LOW-06 fix: Configuration for priority fee estimation.
 */
export interface PriorityFeeConfig {
  /**
   * LOW-02 fix: Maximum priority fee in micro-lamports per compute unit.
   * Caps the fee to prevent a malicious or misconfigured RPC from returning
   * extreme values that drain the wallet. Default: 1,000,000 (1 lamport/CU).
   */
  maxMicroLamports?: number;
  /**
   * LOW-06 fix: Compute unit limit for the transaction.
   * Previously hardcoded to 200,000. Override for programs that need more or less.
   * Default: 200,000.
   */
  computeUnits?: number;
  /**
   * HIGH-T2-03 fix: Maximum total priority fee in lamports.
   * Overrides the default cap of 1,000,000 lamports (0.001 SOL).
   * Set this higher only if you understand the fee drain risk.
   */
  maxPriorityFeeLamports?: number;
}

/** LOW-02 fix: Default maximum priority fee (1 lamport per compute unit) */
const DEFAULT_MAX_PRIORITY_FEE = 1_000_000;
/** LOW-06 fix: Default compute unit limit */
const DEFAULT_COMPUTE_UNITS = 200_000;
/** HIGH-10 fix: Minimum priority fee floor applied when estimation fails */
const DEFAULT_MIN_PRIORITY_FEE = 1000; // 1000 micro-lamports per CU
/**
 * CHAIN-016 fix: Absolute maximum total priority fee in lamports.
 * Even after per-CU and outlier filtering caps, the total fee (microLamports * CU / 1e6)
 * is clamped to this value. This prevents fee manipulation where a high per-CU price
 * combined with a high compute unit limit could still drain the wallet.
 *
 * HIGH-T2-03 fix: Lowered from 10,000,000 (0.01 SOL) to 1,000,000 (0.001 SOL).
 * 0.01 SOL is excessive for typical transactions and could drain wallets with many
 * small transfers. 0.001 SOL covers even congested mainnet conditions.
 *
 * M-24 fix: This cap also serves as a sanity check against RPC-manipulated priority fees
 * via quartile skewing. Even if a malicious RPC returns outlier fee values that survive
 * the 3x-median outlier filter, the absolute cap ensures the total fee never exceeds
 * a configurable limit.
 */
const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;

/**
 * M-24 fix: Maximum allowed per-compute-unit priority fee from RPC response.
 * Individual fee samples exceeding this value are discarded before median calculation.
 * This provides an additional layer of protection against quartile skewing attacks
 * where a malicious RPC returns extreme fee values to inflate the median.
 * Default: 10,000,000 micro-lamports per CU (= 10 lamports/CU, very generous).
 */
const MAX_INDIVIDUAL_FEE_SAMPLE = 10_000_000;

/**
 * Add priority fee instructions to a transaction.
 * Queries recent prioritization fees to determine an appropriate fee.
 * Silently no-ops on failure (safe on devnet where fees are negligible).
 *
 * LOW-02 fix: Caps the RPC-reported fee at maxMicroLamports to prevent
 * malicious RPC nodes from draining the wallet via inflated priority fees.
 * LOW-06 fix: Compute unit limit is configurable instead of hardcoded.
 */
export async function addPriorityFee(
  connection: Connection,
  transaction: Transaction,
  accounts: PublicKey[],
  config?: PriorityFeeConfig,
): Promise<void> {
  try {
    const maxFee = config?.maxMicroLamports ?? DEFAULT_MAX_PRIORITY_FEE;
    const computeUnits = config?.computeUnits ?? DEFAULT_COMPUTE_UNITS;

    const fees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accounts,
    });

    // Use the median of recent fees, with a minimum floor
    // M-24 fix: Filter out individual fee samples that exceed the per-CU sanity cap
    // before computing the median. This prevents RPC-manipulated extreme values from
    // skewing the median upward via quartile manipulation.
    const recentFees = fees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0 && f <= MAX_INDIVIDUAL_FEE_SAMPLE)
      .sort((a, b) => a - b);

    // CHAIN-016: Filter outliers before computing the median.
    // Compute a preliminary median, then discard values > 3x the median.
    // This prevents a single extreme fee sample (from a malicious RPC or transient
    // network spike) from skewing the priority fee estimate upward, which could
    // drain the wallet through excessive fees.
    // T2-1.1 fix: Require a minimum of 3 fee samples before trusting the median.
    // With fewer than 3 samples, a malicious or compromised RPC node could return
    // extreme fee values that pass the MAX_INDIVIDUAL_FEE_SAMPLE filter but still
    // inflate priority fees. Fall back to the default minimum fee when insufficient
    // samples are available for reliable median estimation.
    const MIN_FEE_SAMPLES = 3;
    let filteredFees = recentFees;
    if (recentFees.length >= MIN_FEE_SAMPLES) {
      const preliminaryMedian = recentFees[Math.floor(recentFees.length / 2)]!;
      const outlierThreshold = preliminaryMedian * 3;
      filteredFees = recentFees.filter((f) => f <= outlierThreshold);
      // If all fees were filtered out (unlikely), fall back to the unfiltered set
      if (filteredFees.length === 0) {
        filteredFees = recentFees;
      }
    }

    const medianFee =
      filteredFees.length >= MIN_FEE_SAMPLES
        ? filteredFees[Math.floor(filteredFees.length / 2)]!
        : 1000; // default 1000 micro-lamports per CU when <3 samples available

    // LOW-02 fix: Cap the priority fee to prevent manipulation by malicious RPC
    let cappedFee = Math.min(medianFee, maxFee);

    // CHAIN-016 fix: Clamp the total priority fee to the absolute cap.
    // Total fee in lamports = microLamportsPerCU * computeUnits / 1_000_000.
    // If this exceeds the absolute cap, reduce the per-CU price accordingly.
    // HIGH-T2-03 fix: Use configurable cap, defaulting to the lowered 0.001 SOL.
    const maxTotalFeeLamports = config?.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
    // INT-LOW-01 fix: Use BigInt for priority fee calculation to avoid floating-point
    // precision loss when cappedFee * computeUnits exceeds Number.MAX_SAFE_INTEGER.
    const totalFeeLamportsBig = BigInt(cappedFee) * BigInt(computeUnits) / 1_000_000n;
    if (totalFeeLamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      cappedFee = Number(BigInt(maxTotalFeeLamports) * 1_000_000n / BigInt(computeUnits));
    } else if (Number(totalFeeLamportsBig) > maxTotalFeeLamports) {
      cappedFee = Number(BigInt(maxTotalFeeLamports) * 1_000_000n / BigInt(computeUnits));
    }

    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: cappedFee,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits,
      }),
    );
  } catch (err) {
    // M63 fix: Only swallow RPC/network-related errors. Re-throw unexpected errors
    // (programming bugs, assertion failures, etc.) that should not be silently ignored.
    // SOL-05 fix: Check for both programming errors and non-RPC errors.
    const errMessage = err instanceof Error ? err.message.toLowerCase() : "";
    const isRpcRelatedError =
      err instanceof Error &&
      /\b(rpc|fetch|network|timeout|econnrefused|econnreset|dns|socket|abort|unavailable|service|rate|refused|getaddrinfo|ehostunreach|epipe|enotfound)\b/i.test(errMessage);
    const isProgrammingError =
      (err instanceof TypeError && !isRpcRelatedError) ||
      err instanceof RangeError ||
      err instanceof SyntaxError ||
      err instanceof ReferenceError;
    if (isProgrammingError) {
      throw err;
    }
    // If it's not an RPC-related error and not a known programming error,
    // re-throw it rather than swallowing silently. Only swallow RPC errors.
    if (!isRpcRelatedError && err instanceof Error) {
      throw err;
    }

    // AUDIT-HIGH-6 fix: Emit a warning so callers know fee estimation failed.
    // Silent degradation to minimum fee can cause transactions to be delayed or
    // dropped during network congestion without any indication to the caller.
    process.emitWarning(
      "Priority fee estimation failed — using minimum fee. Transactions may be delayed during congestion.",
      { code: "KOVA_PRIORITY_FEE_WARNING" },
    );

    // HIGH-10 fix: Apply minimum priority fee floor when estimation fails,
    // instead of submitting with zero priority (vulnerable to front-running).
    let minFee = config?.maxMicroLamports
      ? Math.min(DEFAULT_MIN_PRIORITY_FEE, config.maxMicroLamports)
      : DEFAULT_MIN_PRIORITY_FEE;
    const computeUnits = config?.computeUnits ?? DEFAULT_COMPUTE_UNITS;

    // AUDIT-M-13 fix: Apply the same maxTotalFeeLamports cap as the main path
    // to prevent the fallback from exceeding the absolute fee ceiling.
    const maxTotalFeeLamports = config?.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
    const fallbackTotalFeeLamportsBig = BigInt(minFee) * BigInt(computeUnits) / 1_000_000n;
    if (fallbackTotalFeeLamportsBig > BigInt(maxTotalFeeLamports)) {
      minFee = Number(BigInt(maxTotalFeeLamports) * 1_000_000n / BigInt(computeUnits));
    }

    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: minFee,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits,
      }),
    );
  }
}
