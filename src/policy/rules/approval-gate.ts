/**
 * ApprovalGateRule — Requires human approval for transactions above a threshold.
 *
 * Behavior:
 * - If transaction amount is below the threshold → ALLOW
 * - If above threshold and no approval channel configured → DENY (fail closed)
 * - If above threshold and channel available → request approval and wait
 *   - approved → ALLOW
 *   - rejected → DENY
 *   - timeout → DENY
 * - If approval channel throws → DENY (fail closed)
 */

import { createHash } from "node:crypto";
import type { PolicyRule, PolicyDecision, PolicyContext, ApprovalGateConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";
import type { ApprovalRequest } from "../../approval/interface.js";
import { normalizeTokenId, parseAndValidateLimitAmount } from "../utils.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * H-08 FIX: Maximum length for the agent-provided reason field.
 * Truncated to prevent social engineering via excessively long or crafted messages.
 */
const MAX_REASON_LENGTH = 200;

/**
 * H-08 FIX: Sanitize the agent-provided reason field before including in approval requests.
 * This prevents social engineering attacks where a malicious agent crafts a reason field
 * containing HTML, markdown, control characters, or misleading content to trick human
 * approvers into approving malicious transactions.
 *
 * Sanitization steps:
 * 1. Strip HTML tags (prevents injection in web-based approval UIs)
 * 2. Strip markdown formatting (prevents misleading emphasis/links)
 * 3. Strip control characters (prevents terminal escape sequences)
 * 4. Truncate to MAX_REASON_LENGTH characters
 * 5. Prefix with a warning that the reason is agent-provided
 */
function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason || typeof reason !== "string") return undefined;

  let sanitized = reason;

  // Strip HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  // Strip markdown links [text](url) and images ![alt](url)
  sanitized = sanitized.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Strip markdown formatting: bold, italic, strikethrough, code
  sanitized = sanitized.replace(/[*_~`#]+/g, "");

  // Strip control characters (C0 and C1 control codes, except space/newline/tab)
  // This prevents terminal escape sequences and other invisible manipulation
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");

  // Collapse multiple whitespace characters into single space
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  // Truncate to maximum length
  if (sanitized.length > MAX_REASON_LENGTH) {
    sanitized = sanitized.slice(0, MAX_REASON_LENGTH) + "...";
  }

  if (sanitized.length === 0) return undefined;

  // Prefix with warning that this is agent-provided content
  return `[AGENT-PROVIDED, MAY NOT BE TRUSTWORTHY] ${sanitized}`;
}

/**
 * HIGH-05 fix: Compute a SHA-256 hash of the intent parameters.
 * This cryptographically binds the approval to the exact transaction,
 * preventing modification of the intent between approval and execution.
 *
 * POLICY-008: The intent hash is computed from the intent object reference. If the
 * intent were mutated between hashing and approval verification, the hash would no
 * longer match the approved transaction. This TOCTOU risk is mitigated by CORE-005:
 * AgentWallet.execute() performs a structuredClone of the intent at entry, ensuring
 * the policy engine operates on an immutable snapshot that cannot be mutated by the
 * caller during async approval flows.
 *
 * POLICY-018: JSON.stringify is used here to serialize the intent for hashing. Key
 * ordering in JSON.stringify is deterministic in V8/Node.js for non-integer string
 * keys (they follow insertion order per the ECMAScript spec). Since TransactionIntent
 * objects are constructed with consistent key ordering (type, chain, params), the
 * hash output is stable. Integer-keyed properties (e.g., array indices) are always
 * enumerated first in numeric order, which is also deterministic. If cross-engine
 * determinism is ever required, consider using a canonical JSON serialization library.
 */
function computeIntentHash(intent: TransactionIntent): string {
  const payload = JSON.stringify({
    type: intent.type,
    chain: intent.chain,
    params: intent.params,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export class ApprovalGateRule implements PolicyRule {
  readonly name = "approval-gate";
  private readonly config: ApprovalGateConfig;

  constructor(config: ApprovalGateConfig) {
    // MED-34 fix: Validate limit amounts at construction time
    parseAndValidateLimitAmount(config.above.amount, "ApprovalGate above");
    if (config.aboveUSD) parseAndValidateLimitAmount(config.aboveUSD.amount, "ApprovalGate aboveUSD");
    this.config = config;
  }

  /** Get the approval gate configuration (for policy introspection) */
  getConfig(): Readonly<ApprovalGateConfig> {
    return this.config;
  }

  async evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const amount = this.extractAmount(intent);

    // CRIT-01 fix: Fail-closed — if we can't determine the transaction amount,
    // require approval (or deny if no approval channel). This prevents custom and
    // mint intents from bypassing the approval gate entirely.
    if (amount === null) {
      if (!context.approval) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Cannot determine transaction amount for intent type "${intent.type}" — ` +
            `approval gate requires a quantifiable amount, and no approval channel is configured`,
        };
      }

      // Request human approval for unquantifiable transactions
      const request = this.buildApprovalRequestForUnknownAmount(intent, context.now);
      try {
        const result = await context.approval.requestApproval(request);
        if (result.decision === "approved") {
          return { decision: "ALLOW" };
        }
        if (result.decision === "timeout") {
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Approval request timed out for unquantifiable ${intent.type} intent`,
          };
        }
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Unquantifiable ${intent.type} intent was rejected by approver${result.decidedBy ? ` (${result.decidedBy})` : ""}`,
        };
      } catch {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Approval channel error: failed to get approval for unquantifiable ${intent.type} intent`,
        };
      }
    }

    const token = this.extractToken(intent);

    // HIGH-04 fix: Check USD-denominated threshold first (applies to ALL tokens).
    // This prevents bypass via token mismatch (e.g., using USDC when gate is configured for SOL).
    if (this.config.aboveUSD && context.getValueInUSD) {
      try {
        const usdValue = await context.getValueInUSD(token, String(amount));
        const usdThreshold = parseFloat(this.config.aboveUSD.amount);
        // HIGH-T4-04 fix: Use >= so exact-threshold transactions also require approval.
        // Previously `>` allowed a transaction at exactly the threshold to bypass approval.
        if (Number.isFinite(usdThreshold) && usdValue >= usdThreshold) {
          return this.requestApprovalOrDeny(intent, context, amount, token,
            `Transaction of $${usdValue.toFixed(2)} (${amount} ${token}) exceeds USD approval threshold of $${usdThreshold}`);
        }
      } catch {
        // If USD price unavailable and USD threshold configured, fail-closed
        return this.requestApprovalOrDeny(intent, context, amount, token,
          `USD approval threshold configured but cannot determine USD value for ${token}`);
      }
    }

    // Check if amount is above the threshold (token-aware)
    if (normalizeTokenId(token) !== normalizeTokenId(this.config.above.token)) {
      // POLICY-001 fix: When the transaction token doesn't match the configured gate
      // token and no USD threshold is set, DENY the transaction. Previously this returned
      // ALLOW, which meant a gate configured for "SOL" would silently pass large USDC
      // transfers without approval. This is a fail-open vulnerability.
      if (!this.config.aboveUSD) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Transaction token does not match approval gate configuration and no USD threshold is set`,
        };
      }
      // T8-F11 fix: This ALLOW is reached only when:
      //   1. The transaction token does NOT match the configured gate token, AND
      //   2. A USD threshold IS configured (aboveUSD), AND
      //   3. The USD value check above (line ~172) did NOT trigger (value is below USD threshold).
      // In this case, the transaction is in a different token but under the USD threshold,
      // so it is safe to allow without per-token approval. This is intentional — the USD
      // threshold serves as the universal safety net across all tokens.
      return { decision: "ALLOW" };
    }

    const threshold = parseFloat(this.config.above.amount);
    if (amount <= threshold) {
      return { decision: "ALLOW" };
    }

    // Amount exceeds threshold — require approval
    if (!context.approval) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Transaction of ${amount} ${token} exceeds approval threshold of ${threshold} ${this.config.above.token}, but no approval channel is configured`,
      };
    }

    // Amount exceeds threshold — delegate to requestApprovalOrDeny
    return this.requestApprovalOrDeny(intent, context, amount, token,
      `Transaction of ${amount} ${token} exceeds approval threshold of ${threshold} ${this.config.above.token}`);
  }

  /**
   * HIGH-04/HIGH-12 fix: Shared approval request + verification logic.
   * Requests approval and verifies the intent hash post-approval to prevent TOCTOU.
   */
  private async requestApprovalOrDeny(
    intent: TransactionIntent,
    context: PolicyContext,
    amount: number,
    token: string,
    denyReason: string,
  ): Promise<PolicyDecision> {
    if (!context.approval) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `${denyReason}, but no approval channel is configured`,
      };
    }

    const request = this.buildApprovalRequest(intent, amount, token, context.now);

    // CRIT-03 fix: Store the original intent hash BEFORE sending the approval request.
    // We will re-compute the hash after approval returns and compare against this stored
    // value, rather than comparing against result.intentHash (which the approval channel
    // simply echoes back, making it a tautological self-comparison).
    //
    // L-01 NOTE: This hash re-verification is defense-in-depth, NOT tautological.
    // While CORE-005's structuredClone in AgentWallet.execute() currently ensures the
    // intent is an immutable snapshot, this hash check provides an independent safety net:
    // 1. It protects against future code changes that might remove structuredClone
    // 2. It catches bugs in approval channel implementations that modify the intent
    // 3. It guards against prototype pollution or proxy-based attacks on the intent object
    // 4. It satisfies defense-in-depth: even if one protection fails, the other catches it
    // The cost (one extra SHA-256 hash) is negligible compared to the approval round-trip.
    const originalIntentHash = request.intentHash;

    try {
      const result = await context.approval.requestApproval(request);

      if (result.decision === "approved") {
        // CRIT-03 fix: Re-compute the intent hash from the current intent and compare
        // to the ORIGINAL hash that was sent. This detects TOCTOU attacks where the
        // intent object is mutated between approval request and execution.
        if (originalIntentHash) {
          const recomputedHash = computeIntentHash(intent);
          if (recomputedHash !== originalIntentHash) {
            return {
              decision: "DENY",
              rule: this.name,
              reason: `Approval intent hash mismatch: the transaction was modified after approval was requested. ` +
                `Original ${originalIntentHash.slice(0, 16)}..., re-computed ${recomputedHash.slice(0, 16)}...`,
            };
          }
        }
        return { decision: "ALLOW" };
      }

      if (result.decision === "timeout") {
        return {
          decision: "DENY",
          rule: this.name,
          reason: `Approval request timed out for ${amount} ${token} transaction`,
        };
      }

      // rejected
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Transaction of ${amount} ${token} was rejected by approver${result.decidedBy ? ` (${result.decidedBy})` : ""}`,
      };
    } catch {
      // Fail closed on approval channel errors
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Approval channel error: failed to get approval for ${amount} ${token} transaction`,
      };
    }
  }

  /**
   * Build an ApprovalRequest from the intent.
   * MED-T4-06 fix: Accepts an optional `now` parameter (from context.now) to use
   * as the time base for computing expiresAt, ensuring consistency with the policy
   * engine's injectable time source. Falls back to Date.now() if not provided.
   */
  private buildApprovalRequest(
    intent: TransactionIntent,
    amount: number,
    token: string,
    now?: number,
  ): ApprovalRequest {
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const params = intent.params as unknown as Record<string, unknown>;

    // H-08 FIX: Sanitize agent-provided reason to prevent social engineering
    const rawReason = typeof params.reason === "string" ? params.reason : intent.metadata?.reason as string | undefined;

    // MED-T4-06 fix: Use context.now for consistency with the policy engine's time source
    const effectiveNow = now ?? Date.now();

    return {
      // LOW-T4-02 fix: UUID v4 collision is acceptable given 122 random bits of entropy.
      // At 1 billion approval requests, collision probability is < 1e-18 (birthday bound:
      // p ≈ n²/2^123 ≈ 10^18/10^37 ≈ 10^-19). No collision check is needed.
      id: crypto.randomUUID(),
      summary: `${intent.type} ${amount} ${token}`,
      amount: String(amount),
      token,
      target: this.extractTarget(intent),
      reason: sanitizeReason(rawReason),
      agentId: intent.metadata?.agentId as string | undefined,
      expiresAt: effectiveNow + timeoutMs,
      // HIGH-05 fix: Cryptographically bind approval to exact transaction parameters
      intentHash: computeIntentHash(intent),
    };
  }

  /**
   * CRIT-01 fix: Build approval request for intents with no extractable amount.
   * MED-T4-06 fix: Accepts an optional `now` parameter for time source consistency.
   */
  private buildApprovalRequestForUnknownAmount(intent: TransactionIntent, now?: number): ApprovalRequest {
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const params = intent.params as unknown as Record<string, unknown>;

    // H-08 FIX: Sanitize agent-provided reason to prevent social engineering
    const rawReason = typeof params.reason === "string" ? params.reason : intent.metadata?.reason as string | undefined;

    // MED-T4-06 fix: Use context.now for consistency with the policy engine's time source
    const effectiveNow = now ?? Date.now();

    return {
      // LOW-T4-02 fix: UUID v4 collision acceptable — 122 random bits, see buildApprovalRequest.
      id: crypto.randomUUID(),
      summary: `${intent.type} (unknown amount) — requires manual approval`,
      amount: "unknown",
      token: "unknown",
      target: this.extractTarget(intent),
      reason: sanitizeReason(rawReason),
      agentId: intent.metadata?.agentId as string | undefined,
      expiresAt: effectiveNow + timeoutMs,
      // HIGH-05 fix: Cryptographically bind approval to exact transaction parameters
      intentHash: computeIntentHash(intent),
    };
  }

  /**
   * Extract the numeric amount from an intent's params. S2-13 fix: rejects negative/zero.
   *
   * M-06 FIX: Aligned with SpendingLimitRule.extractAmount() to ensure both rules
   * parse amounts identically. Differences in parsing could cause the approval gate
   * to see a different amount than the spending limit, creating inconsistent enforcement.
   * Both now:
   * - Use BigInt for pure integer amounts (prevents precision loss for large values)
   * - Reject amounts with more than 18 decimal places (H-15 alignment)
   * - Validate decimal format before parseFloat
   * - Reject non-finite, NaN, zero, and negative values
   */
  private extractAmount(intent: TransactionIntent): number | null {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("amount" in params && typeof params.amount === "string") {
      // M-06 FIX: Reject amounts with more than 18 decimal places (aligned with SpendingLimit H-15)
      const dotIndex = params.amount.indexOf(".");
      if (dotIndex !== -1) {
        const decimalPlaces = params.amount.length - dotIndex - 1;
        if (decimalPlaces > 18) {
          return null;
        }
      }

      // M-06 FIX: BigInt-based extraction for integer amounts (aligned with SpendingLimit)
      if (/^\d+$/.test(params.amount)) {
        try {
          const bigAmount = BigInt(params.amount);
          if (bigAmount <= 0n) return null;
          return Number(bigAmount);
        } catch {
          return null;
        }
      }

      // M-06 FIX: Validate decimal format before parseFloat (aligned with SpendingLimit)
      if (!/^\d+\.\d+$/.test(params.amount)) {
        return null;
      }
      const parsed = parseFloat(params.amount);
      return (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) ? null : parsed;
    }
    return null;
  }

  /** Extract the token symbol from an intent's params */
  private extractToken(intent: TransactionIntent): string {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("token" in params && typeof params.token === "string") {
      return params.token;
    }
    if ("fromToken" in params && typeof params.fromToken === "string") {
      return params.fromToken;
    }
    return "UNKNOWN";
  }

  /** Extract the target address from an intent */
  private extractTarget(intent: TransactionIntent): string {
    const params = intent.params as unknown as Record<string, unknown>;
    if ("to" in params && typeof params.to === "string") return params.to;
    if ("programId" in params && typeof params.programId === "string") return params.programId;
    if ("collection" in params && typeof params.collection === "string") return params.collection;
    if ("validator" in params && typeof params.validator === "string") return params.validator;
    return "unknown";
  }
}
