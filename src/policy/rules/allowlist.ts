/**
 * AllowlistRule — Restricts which addresses and programs the agent can interact with.
 *
 * Evaluation order (deny takes precedence):
 * 1. If address is in denyAddresses → DENY
 * 2. If allowAddresses is configured and address is NOT in it → DENY
 * 3. If programId is in denyPrograms → DENY
 * 4. If allowPrograms is configured and programId is NOT in it → DENY
 * 5. Otherwise → ALLOW
 */

import type { PolicyRule, PolicyDecision, PolicyContext } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";

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

/**
 * SEC: Normalize token identifiers for comparison.
 * - Token symbols are case-insensitive ("usdc" == "USDC")
 * - Address-like identifiers (e.g. Solana base58 mints) remain case-sensitive
 * - EVM addresses are normalized to lowercase
 */
function normalizeTokenId(token: string): string {
  if (token.startsWith("0x") && token.length === 42) return token.toLowerCase();
  if (/^[A-Za-z0-9_]{2,16}$/.test(token)) return token.toUpperCase();
  return token;
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

    // 1. Check deny addresses (deny takes precedence)
    if (targetAddress && this.denyAddresses.has(targetAddress)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Address is denylisted: ${targetAddress}`,
      };
    }

    // 2. Check allow addresses (if configured, address must be in the list)
    if (targetAddress && this.hasAllowAddresses && !this.allowAddresses.has(targetAddress)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Address is not in the allowlist: ${targetAddress}`,
      };
    }

    // 3. Check deny programs
    if (programId && this.denyPrograms.has(programId)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Program is denylisted: ${programId}`,
      };
    }

    // 4. Check allow programs (if configured, program must be in the list)
    if (programId && this.hasAllowPrograms && !this.allowPrograms.has(programId)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Program is not in the allowlist: ${programId}`,
      };
    }

    // 5. SEC: Check swap token allowlist/denylist
    const swapTokens = this.extractSwapTokens(intent);
    if (swapTokens) {
      for (const token of swapTokens) {
        const normalized = normalizeTokenId(token);
        if (this.denyTokens.has(normalized)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Token is denylisted for swaps: ${token}`,
          };
        }
        if (this.hasAllowTokens && !this.allowTokens.has(normalized)) {
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Token is not in the swap allowlist: ${token}`,
          };
        }
      }
    }

    return { decision: "ALLOW" };
  }

  /** Extract the target/recipient address from an intent */
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

  /** Extract the program ID from an intent (only for custom intents) */
  private extractProgramId(intent: TransactionIntent): string | null {
    const params = intent.params as unknown as Record<string, unknown>;
    if (intent.type === "custom" && "programId" in params && typeof params.programId === "string") {
      return params.programId;
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
