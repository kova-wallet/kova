/**
 * AllowlistRule — Restricts which addresses and programs the agent can interact with.
 *
 * Evaluation order (deny takes precedence):
 * 1. If address is in denyAddresses → DENY
 * 2. If allowAddresses is configured and address is NOT in it → DENY
 * 3. If programId is in denyPrograms → DENY
 * 4. If allowPrograms is configured and programId is NOT in it → DENY
 * 5. Otherwise → ALLOW
 *
 * MED-05 LIMITATION: This rule does NOT verify the DEX program used for swap intents.
 * When a swap intent is evaluated, the allowlist checks the fromToken/toToken via
 * allowTokens/denyTokens, but it does NOT validate which DEX aggregator program
 * is used to execute the swap. To mitigate this, configure allowPrograms with trusted
 * DEX program IDs and ensure swap intents include a programId field.
 *
 * M-05 FIX (supersedes POLICY-006): Program allowlist/denylist is now checked for ALL
 * intent types that include a programId field, not just custom intents. While the chain
 * adapter typically hardcodes programs for transfer/swap intents, checking the programId
 * field (when present) provides defense-in-depth against malicious intent construction.
 * If the programId field is absent from a transfer/swap intent, program checks are skipped
 * for that intent (the chain adapter is trusted to use the correct program).
 */

import type { PolicyRule, PolicyDecision, PolicyContext } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";
import { normalizeTokenId } from "../utils.js";

export interface AllowlistConfig {
  allowAddresses?: string[];
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
  /** Allowed token symbols/mints for swap intents. If set, swaps to unlisted tokens are denied. */
  allowTokens?: string[];
  /** Denied token symbols/mints for swap intents. Swaps involving these tokens are denied. */
  denyTokens?: string[];
}

// POLICY-008 fix: Base58 alphabet for Solana address validation.
const BASE58_ALPHABET = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

/**
 * HIGH-24 fix: Well-known Solana program IDs for standard intent types.
 * These are used by extractProgramId() to return the appropriate program ID
 * for transfer and swap intents, enabling program allowlist/denylist enforcement
 * for standard operations — not just custom intents.
 *
 * Without these, extractProgramId() returned null for transfers and swaps,
 * effectively bypassing any configured program allowlists for the most common
 * transaction types.
 */
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * POLICY-008 fix: Validate that a Solana address is well-formed base58 of correct length.
 * Solana public keys are 32 bytes, encoded as 32–44 character base58 strings.
 * Emits a warning at construction time for misconfigured addresses that would
 * silently deny all intended transactions.
 */
/**
 * M11 FIX: Reject addresses containing non-ASCII characters. Unicode homoglyphs
 * (e.g., Cyrillic 'а' U+0430 vs Latin 'a' U+0061) could pass visual inspection
 * but represent different addresses, enabling allowlist bypass attacks.
 */
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

function warnIfInvalidSolanaAddress(address: string, listName: string): void {
  // M11 FIX: Hard-reject addresses with non-ASCII characters (Unicode homoglyph defense)
  // Skip empty strings — they're caught by the empty address validation downstream
  if (address.length > 0 && !ASCII_PRINTABLE.test(address)) {
    throw new Error(
      `AllowlistRule: address "${address.slice(0, 20)}..." in ${listName} contains non-ASCII characters. ` +
      `Only ASCII printable characters (0x20-0x7E) are allowed in addresses to prevent Unicode homoglyph attacks.`,
    );
  }
  // Skip EVM addresses
  if (address.startsWith("0x") && address.length === 42) return;
  // Solana base58 addresses are 32-44 characters
  if (address.length < 32 || address.length > 44 || !BASE58_ALPHABET.test(address)) {
    process.emitWarning(
      `AllowlistRule: address "${address.slice(0, 20)}..." in ${listName} does not appear to be a valid ` +
      `Solana address (expected 32-44 base58 characters). Misconfigured addresses will silently ` +
      `deny all intended transactions.`,
      "KovaAllowlistWarning",
    );
  }
}

/**
 * HIGH-03 fix: Normalize EVM addresses to lowercase for case-insensitive matching.
 * Solana addresses are case-sensitive (base58), so they are left as-is.
 */
function normalizeAddress(address: string): string {
  // AUDIT-M12 fix: Trim whitespace before normalization to prevent silent mismatches.
  // An address like " RecipientAddr " would fail to match "RecipientAddr" in the allowlist.
  const trimmed = address.trim();
  // EVM addresses start with 0x and are 42 characters long (case-insensitive per EIP-55)
  if (trimmed.startsWith("0x") && trimmed.length === 42) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export class AllowlistRule implements PolicyRule {
  readonly name = "allowlist";
  private readonly allowAddresses: Set<string>;
  private readonly denyAddresses: Set<string>;
  private readonly allowPrograms: Set<string>;
  private readonly denyPrograms: Set<string>;
  private readonly allowTokens: Set<string>;
  private readonly denyTokens: Set<string>;
  private readonly hasAllowAddresses: boolean;
  private readonly hasAllowPrograms: boolean;
  private readonly hasAllowTokens: boolean;

  constructor(config: AllowlistConfig) {
    // POL-04 fix: Reject empty allowlists at construction time. An AllowlistRule with an
    // explicit but empty allowAddresses array is a no-op that allows all addresses — a
    // dangerous misconfiguration. If you want to allow all addresses, omit allowAddresses
    // entirely and use only denyAddresses. Same logic applies to allowPrograms and allowTokens.
    if (config.allowAddresses !== undefined && config.allowAddresses.length === 0) {
      throw new Error(
        "AllowlistRule: allowAddresses is set but empty. An empty allowlist permits all addresses. " +
        "Provide at least one address, or omit allowAddresses entirely.",
      );
    }
    if (config.allowPrograms !== undefined && config.allowPrograms.length === 0) {
      throw new Error(
        "AllowlistRule: allowPrograms is set but empty. An empty program allowlist permits all programs. " +
        "Provide at least one program, or omit allowPrograms entirely.",
      );
    }
    if (config.allowTokens !== undefined && config.allowTokens.length === 0) {
      throw new Error(
        "AllowlistRule: allowTokens is set but empty. An empty token allowlist permits all tokens. " +
        "Provide at least one token, or omit allowTokens entirely.",
      );
    }
    // POLICY-008 fix: Warn about potentially invalid Solana addresses at construction time
    for (const addr of config.allowAddresses ?? []) warnIfInvalidSolanaAddress(addr, "allowAddresses");
    for (const addr of config.denyAddresses ?? []) warnIfInvalidSolanaAddress(addr, "denyAddresses");
    // HIGH-03 fix: Normalize addresses for case-insensitive matching on EVM chains
    this.allowAddresses = new Set((config.allowAddresses ?? []).map(normalizeAddress));
    this.denyAddresses = new Set((config.denyAddresses ?? []).map(normalizeAddress));
    // P-12 NOTE: Program IDs are stored as-is without normalization. Solana program IDs
    // are base58-encoded and case-sensitive. For future EVM support, program/contract
    // addresses may need case-insensitive normalization (similar to normalizeAddress).
    this.allowPrograms = new Set(config.allowPrograms ?? []);
    this.denyPrograms = new Set(config.denyPrograms ?? []);
    // SEC: Token allowlist/denylist for swap intents (case-insensitive matching)
    this.allowTokens = new Set((config.allowTokens ?? []).map(normalizeTokenId));
    this.denyTokens = new Set((config.denyTokens ?? []).map(normalizeTokenId));
    this.hasAllowAddresses = this.allowAddresses.size > 0;
    this.hasAllowPrograms = this.allowPrograms.size > 0;
    this.hasAllowTokens = this.allowTokens.size > 0;
  }

  /** Get the allowlist configuration (for policy introspection) */
  getConfig(): AllowlistConfig {
    return {
      allowAddresses: this.hasAllowAddresses ? [...this.allowAddresses] : undefined,
      denyAddresses: this.denyAddresses.size > 0 ? [...this.denyAddresses] : undefined,
      allowPrograms: this.hasAllowPrograms ? [...this.allowPrograms] : undefined,
      denyPrograms: this.denyPrograms.size > 0 ? [...this.denyPrograms] : undefined,
      allowTokens: this.hasAllowTokens ? [...this.allowTokens] : undefined,
      denyTokens: this.denyTokens.size > 0 ? [...this.denyTokens] : undefined,
    };
  }

  async evaluate(intent: TransactionIntent, _context: PolicyContext): Promise<PolicyDecision> {
    // Extract the target address from the intent
    const rawTargetAddress = this.extractTargetAddress(intent);
    // HIGH-03 fix: Normalize extracted address for case-insensitive EVM matching
    const targetAddress = rawTargetAddress ? normalizeAddress(rawTargetAddress) : null;
    const programId = this.extractProgramId(intent);

    // POLICY-005 fix: Reject empty string addresses. An empty or whitespace-only address
    // could bypass both allowlist and denylist checks since it wouldn't match any entry,
    // effectively allowing transactions to proceed without proper address validation.
    if (rawTargetAddress !== null && (!rawTargetAddress || rawTargetAddress.trim().length === 0)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Empty target address is not permitted",
      };
    }

    // H-38 FIX: All denial messages below use generic wording that does NOT expose
    // specific allowed/denied addresses or programs. Previously, messages included the
    // actual address (e.g., "Address is denylisted: 0x123..."), which could leak
    // information about the allowlist/denylist configuration to an attacker probing
    // the system. Generic messages prevent this information disclosure.

    // 1. Check deny addresses (deny takes precedence)
    if (targetAddress && this.denyAddresses.has(targetAddress)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Address is not permitted",
      };
    }

    // 2. Check allow addresses (if configured, address must be in the list)
    if (targetAddress && this.hasAllowAddresses && !this.allowAddresses.has(targetAddress)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Address not in allowlist",
      };
    }

    // M6 FIX: For custom intents, validate ALL writable account addresses against
    // the allowlist/denylist, not just programId. An attacker could set programId to
    // an allowed address while the actual writable target accounts are malicious.
    if (intent.type === "custom") {
      const allAddresses = this.extractAllCustomAddresses(intent);
      for (const rawAddr of allAddresses) {
        const addr = normalizeAddress(rawAddr);
        if (this.denyAddresses.has(addr)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Address is not permitted",
          };
        }
        if (this.hasAllowAddresses && !this.allowAddresses.has(addr)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Address not in allowlist",
          };
        }
      }
    }

    // 3. Check deny programs
    if (programId && this.denyPrograms.has(programId)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Program is not permitted",
      };
    }

    // 4. Check allow programs (if configured, program must be in the list)
    if (programId && this.hasAllowPrograms && !this.allowPrograms.has(programId)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Program not in allowlist",
      };
    }

    // M-03 FIX: Check swap intent fromToken/toToken mint addresses against address lists
    const swapAddrDenial = this.checkSwapAddresses(intent);
    if (swapAddrDenial) return swapAddrDenial;

    // 5. SEC: Check swap token allowlist/denylist
    const swapTokens = this.extractSwapTokens(intent);
    if (swapTokens) {
      for (const token of swapTokens) {
        const normalized = normalizeTokenId(token);
        if (this.denyTokens.has(normalized)) {
          // H-38 FIX: Generic message that does not reveal which tokens are denied
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Token is not permitted for swaps",
          };
        }
        if (this.hasAllowTokens && !this.allowTokens.has(normalized)) {
          // H-38 FIX: Generic message that does not reveal which tokens are allowed
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Token not in swap allowlist",
          };
        }
      }
    }

    // CRIT-05 fix: Fail-closed for intent types that can move funds but have no extractable target.
    // If address or program allowlists are configured, intents without a verifiable target
    // must be explicitly covered by token-level checks (for swaps) or denied.
    // MED-T3-04 fix: Extended from only "swap" and "custom" to include ALL fund-moving intent
    // types: "transfer", "stake", "swap", and "custom". Previously, malformed transfer or stake
    // intents with no extractable target could bypass allowlist checks entirely.
    if (!targetAddress && !programId) {
      const hasFundsMovingIntent = intent.type === "transfer" || intent.type === "stake" ||
        intent.type === "swap" || intent.type === "custom";
      if (hasFundsMovingIntent) {
        // Swaps: if we have no token checks covering them, and address/program lists exist, deny
        const isSwapCoveredByTokenChecks = intent.type === "swap" &&
          (this.hasAllowTokens || this.denyTokens.size > 0);

        if (!isSwapCoveredByTokenChecks && (this.hasAllowAddresses || this.hasAllowPrograms)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Intent type "${intent.type}" has no verifiable target address or program. ` +
              `Address/program allowlists are configured but cannot be checked for this intent type.`,
          };
        }
      }
    }

    return { decision: "ALLOW" };
  }

  /**
   * Extract the target/recipient address from an intent.
   *
   * M-03 FIX: For swap intents, extract fromToken and toToken mint addresses
   * so they can be checked against the address allowlist/denylist. A swap to a
   * denylisted token mint address should be blocked even if it passes token
   * symbol checks.
   */
  /**
   * M6 FIX: For custom intents, returns ALL addresses that need validation:
   * the programId plus all writable account addresses. Returns a single string
   * for non-custom intents (backward compatible), or null if no target is extractable.
   * When multiple addresses are returned (custom intents), they are joined with a
   * sentinel that extractTargetAddresses() splits on.
   */
  private extractTargetAddress(intent: TransactionIntent): string | null {
    // H10 fix: Use discriminated union narrowing instead of unsafe double-cast.
    switch (intent.type) {
      case "transfer":
        return typeof intent.params.to === "string" ? intent.params.to : null;
      case "custom":
        return typeof intent.params.programId === "string" ? intent.params.programId : null;
      case "mint":
        return typeof intent.params.collection === "string" ? intent.params.collection : null;
      case "stake":
        return typeof intent.params.validator === "string" ? intent.params.validator : null;
      default:
        return null;
    }
  }

  /**
   * M6 FIX: Extract ALL target addresses for custom intents, including writable
   * account addresses. An attacker could set programId to an allowed address while
   * the actual target accounts are malicious. This method ensures all writable
   * account addresses are also checked against the allowlist/denylist.
   */
  private extractAllCustomAddresses(intent: TransactionIntent): string[] {
    if (intent.type !== "custom") return [];
    const addresses: string[] = [];
    if (typeof intent.params.programId === "string") {
      addresses.push(intent.params.programId);
    }
    if (Array.isArray(intent.params.accounts)) {
      for (const account of intent.params.accounts) {
        if (account.isWritable && typeof account.address === "string") {
          addresses.push(account.address);
        }
      }
    }
    return addresses;
  }

  /**
   * M-03 FIX: Validate swap intent token mint addresses against address allowlist/denylist.
   * Checks both fromToken and toToken as addresses (not just as token symbols).
   * This catches cases where token mint addresses are denylisted even if the token
   * symbol passes the token allowlist check.
   */
  /**
   * M2 FIX: Validate swap intent fromToken/toToken against the address allowlist/denylist.
   * Previously, when no token-level config (allowTokens/denyTokens) was set, swap intents
   * could bypass address validation entirely because extractTargetAddress returns null for
   * swaps. This method ensures mint addresses (base58-like strings) in fromToken/toToken
   * are always checked against the address allowlist, even without token-level config.
   *
   * Both symbol-like tokens (e.g., "SOL") and mint addresses are checked. Short symbols
   * won't match allowlist entries (which are full addresses), so they naturally pass through
   * to the token-level checks. Mint addresses that look like real addresses are validated.
   */
  private checkSwapAddresses(intent: TransactionIntent): PolicyDecision | null {
    if (intent.type !== "swap") return null;
    // H10 fix: intent.type === "swap" narrows params to SwapParams
    const tokenAddresses: string[] = [];
    if (typeof intent.params.fromToken === "string") {
      tokenAddresses.push(intent.params.fromToken);
    }
    if (typeof intent.params.toToken === "string") {
      tokenAddresses.push(intent.params.toToken);
    }

    for (const rawAddr of tokenAddresses) {
      const addr = normalizeAddress(rawAddr);

      // Check deny addresses — always check, regardless of token-level config
      if (this.denyAddresses.has(addr)) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: "Swap token address is not permitted",
        };
      }

      // M2 FIX: Check allow addresses for mint-address-like tokens even when no
      // token-level config exists. If the token looks like a base58 address (32+ chars),
      // it must be in the address allowlist when one is configured.
      if (this.hasAllowAddresses) {
        const looksLikeAddress = addr.length >= 32 && BASE58_ALPHABET.test(addr);
        if (looksLikeAddress && !this.allowAddresses.has(addr)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Swap token address not in allowlist",
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract the program ID from an intent.
   *
   * M-05 FIX: Extended program allowlist/denylist checking to all intent types that
   * include a programId field, not just custom intents. While POLICY-006 noted that
   * the chain adapter hardcodes programs for transfer/swap intents, the intent object
   * may still carry a programId field (e.g., for auditing or verification). If present,
   * it should be checked against the program allowlist/denylist for defense-in-depth.
   *
   * HIGH-24 fix: For standard intent types (transfer, swap), infer the program ID
   * from the intent type and parameters when no explicit programId field is present.
   * Previously, returning null for these intents effectively bypassed any configured
   * program allowlists, allowing transfers and swaps through programs that an operator
   * explicitly intended to block.
   *
   * Program ID inference:
   * - transfer with token "SOL" -> System Program (native SOL transfer)
   * - transfer with any other token -> Token Program (SPL token transfer)
   * - swap -> null (user-determined; use explicit programId in intent for enforcement)
   * - custom -> uses explicit programId from params
   *
   * If the intent includes an explicit programId field, that takes precedence over
   * the inferred value (defense-in-depth: the explicit value may differ from the
   * default if a different program variant is used).
   */
  // AUDIT-L-4: Program inference is Solana-specific. Gate on intent.chain for multi-chain.
  private extractProgramId(intent: TransactionIntent): string | null {
    // H10 fix: Use discriminated union narrowing instead of unsafe double-cast.
    // Explicit programId in params always takes precedence (only custom intents have it)
    if (intent.type === "custom" && typeof intent.params.programId === "string") {
      return intent.params.programId;
    }

    // HIGH-24 fix: Infer program ID for standard intent types
    if (intent.type === "transfer") {
      // Determine if this is a native SOL transfer or SPL token transfer
      if (typeof intent.params.token === "string") {
        const token = intent.params.token.toUpperCase().trim();
        if (token === "SOL") {
          return SOLANA_SYSTEM_PROGRAM;
        }
        return SOLANA_TOKEN_PROGRAM;
      }
      // Fallback: if no token field, assume System Program (SOL transfer)
      return SOLANA_SYSTEM_PROGRAM;
    }

    if (intent.type === "swap") {
      // Swap program is user-determined (no built-in DEX integration).
      return null;
    }

    // AUDIT-M1 fix: Infer program IDs for mint and stake intents so they are checked
    // against the program allowlist. Previously these returned null, completely bypassing
    // program allowlist checks for mint/stake operations.
    // L21 fix: Also accept the Token-2022 program as an alternative for mint intents,
    // since newer tokens may use Token-2022 instead of the legacy Token program.
    if (intent.type === "mint") {
      // NFT minting typically goes through Metaplex or Token Program.
      // If the operator has allowed the Token-2022 program, return it when the legacy
      // Token program is not in the allowlist but Token-2022 is. Otherwise default to
      // the legacy Token program for backwards compatibility.
      if (this.hasAllowPrograms && !this.allowPrograms.has(SOLANA_TOKEN_PROGRAM) && this.allowPrograms.has(SOLANA_TOKEN_2022_PROGRAM)) {
        return SOLANA_TOKEN_2022_PROGRAM;
      }
      return SOLANA_TOKEN_PROGRAM;
    }

    if (intent.type === "stake") {
      // Staking goes through the Stake Program, but token-related stake operations
      // may use the Token-2022 program instead.
      if (this.hasAllowPrograms && !this.allowPrograms.has("Stake11111111111111111111111111111111111111") && this.allowPrograms.has(SOLANA_TOKEN_2022_PROGRAM)) {
        return SOLANA_TOKEN_2022_PROGRAM;
      }
      return "Stake11111111111111111111111111111111111111";
    }

    return null;
  }

  /** SEC: Extract fromToken and toToken from swap intents for token allowlist checks */
  private extractSwapTokens(intent: TransactionIntent): [string, string] | null {
    if (intent.type !== "swap") return null;
    // H10 fix: intent.type === "swap" narrows params to SwapParams
    if (
      typeof intent.params.fromToken === "string" &&
      typeof intent.params.toToken === "string"
    ) {
      return [intent.params.fromToken, intent.params.toToken];
    }
    return null;
  }
}
