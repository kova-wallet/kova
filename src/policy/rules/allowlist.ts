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
 * (e.g., Jupiter, Raydium, Orca) is used to execute the swap. A malicious or
 * compromised DEX program could drain funds even if token checks pass. To mitigate
 * this, configure allowPrograms with trusted DEX program IDs and ensure swap intents
 * include a programId field, or use a dedicated DEX allowlist in the chain adapter.
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
const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/**
 * POLICY-008 fix: Validate that a Solana address is well-formed base58 of correct length.
 * Solana public keys are 32 bytes, encoded as 32–44 character base58 strings.
 * Emits a warning at construction time for misconfigured addresses that would
 * silently deny all intended transactions.
 */
function warnIfInvalidSolanaAddress(address: string, listName: string): void {
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
  // EVM addresses start with 0x and are 42 characters long (case-insensitive per EIP-55)
  if (address.startsWith("0x") && address.length === 42) {
    return address.toLowerCase();
  }
  return address;
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
    // POLICY-008 fix: Warn about potentially invalid Solana addresses at construction time
    for (const addr of config.allowAddresses ?? []) warnIfInvalidSolanaAddress(addr, "allowAddresses");
    for (const addr of config.denyAddresses ?? []) warnIfInvalidSolanaAddress(addr, "denyAddresses");
    // HIGH-03 fix: Normalize addresses for case-insensitive matching on EVM chains
    this.allowAddresses = new Set((config.allowAddresses ?? []).map(normalizeAddress));
    this.denyAddresses = new Set((config.denyAddresses ?? []).map(normalizeAddress));
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
  private extractTargetAddress(intent: TransactionIntent): string | null {
    const params = intent.params as unknown as Record<string, unknown>;

    // transfer: "to" field
    if ("to" in params && typeof params.to === "string") {
      return params.to;
    }

    // custom: first writable non-signer account, or programId
    if ("programId" in params && typeof params.programId === "string") {
      return params.programId;
    }

    // mint: "collection" field
    if ("collection" in params && typeof params.collection === "string") {
      return params.collection;
    }

    // stake: "validator" field
    if ("validator" in params && typeof params.validator === "string") {
      return params.validator;
    }

    return null;
  }

  /**
   * M-03 FIX: Validate swap intent token mint addresses against address allowlist/denylist.
   * Checks both fromToken and toToken as addresses (not just as token symbols).
   * This catches cases where token mint addresses are denylisted even if the token
   * symbol passes the token allowlist check.
   */
  private checkSwapAddresses(intent: TransactionIntent): PolicyDecision | null {
    if (intent.type !== "swap") return null;
    const params = intent.params as unknown as Record<string, unknown>;

    const tokenAddresses: string[] = [];
    if ("fromToken" in params && typeof params.fromToken === "string") {
      tokenAddresses.push(params.fromToken);
    }
    if ("toToken" in params && typeof params.toToken === "string") {
      tokenAddresses.push(params.toToken);
    }

    for (const rawAddr of tokenAddresses) {
      const addr = normalizeAddress(rawAddr);

      // Check deny addresses
      if (this.denyAddresses.has(addr)) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: "Swap token address is not permitted",
        };
      }

      // Check allow addresses (if configured, swap token address must be in the list)
      if (this.hasAllowAddresses && !this.allowAddresses.has(addr)) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: "Swap token address not in allowlist",
        };
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
   * - swap -> Jupiter v6 (the DEX aggregator used by the Solana adapter)
   * - custom -> uses explicit programId from params
   *
   * If the intent includes an explicit programId field, that takes precedence over
   * the inferred value (defense-in-depth: the explicit value may differ from the
   * default if a different program variant is used).
   */
  // AUDIT-L-4: Program inference is Solana-specific. Gate on intent.chain for multi-chain.
  private extractProgramId(intent: TransactionIntent): string | null {
    const params = intent.params as unknown as Record<string, unknown>;

    // Explicit programId in params always takes precedence
    if ("programId" in params && typeof params.programId === "string") {
      return params.programId;
    }

    // HIGH-24 fix: Infer program ID for standard intent types
    if (intent.type === "transfer") {
      // Determine if this is a native SOL transfer or SPL token transfer
      if ("token" in params && typeof params.token === "string") {
        const token = params.token.toUpperCase().trim();
        if (token === "SOL") {
          return SOLANA_SYSTEM_PROGRAM;
        }
        return SOLANA_TOKEN_PROGRAM;
      }
      // Fallback: if no token field, assume System Program (SOL transfer)
      return SOLANA_SYSTEM_PROGRAM;
    }

    if (intent.type === "swap") {
      // Swaps go through Jupiter DEX aggregator
      return JUPITER_V6_PROGRAM;
    }

    return null;
  }

  /** SEC: Extract fromToken and toToken from swap intents for token allowlist checks */
  private extractSwapTokens(intent: TransactionIntent): [string, string] | null {
    if (intent.type !== "swap") return null;
    const params = intent.params as unknown as Record<string, unknown>;
    if (
      "fromToken" in params && typeof params.fromToken === "string" &&
      "toToken" in params && typeof params.toToken === "string"
    ) {
      return [params.fromToken, params.toToken];
    }
    return null;
  }
}
