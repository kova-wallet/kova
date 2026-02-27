/**
 * Policy serialization — converts between Policy objects and versioned JSON.
 *
 * POLICY-009 fix: Implements schema versioning to support forward/backward
 * compatibility of serialized policies.
 *
 * - On serialization, the current schema version (CURRENT_VERSION) is embedded.
 * - On deserialization, the version is checked and unsupported versions are rejected
 *   with a clear error (fail-closed). This prevents silent policy misinterpretation
 *   when upgrading the SDK, which could lead to spending limits or allowlists being
 *   silently ignored.
 * - Future version upgrades should add migration functions (v1 -> v2, etc.) and
 *   apply them sequentially during deserialization.
 */

import type { PolicyConfig } from "./types.js";
import { Policy } from "./builder.js";
import { normalizeTokenId } from "./utils.js";

export { Policy } from "./builder.js";

/** Current serialization schema version */
const CURRENT_VERSION = 1;

/** Supported versions that can be deserialized */
const SUPPORTED_VERSIONS = new Set([1]);

/** Versioned policy format for serialization */
export interface VersionedPolicyConfig {
  version: number;
  policy: PolicyConfig;
}

/**
 * Serialize a Policy to a versioned JSON-compatible object.
 * Always writes the latest schema version.
 */
export function serializePolicy(policy: Policy): VersionedPolicyConfig {
  return {
    version: CURRENT_VERSION,
    policy: policy.toJSON(),
  };
}

/**
 * Deserialize a versioned JSON object back into a Policy.
 * Rejects unsupported versions with a clear error (fail-closed).
 */
/** POLICY-016 fix: Maximum serialized policy JSON size (1 MB). Prevents DoS via oversized payloads. */
const MAX_SERIALIZED_SIZE = 1_048_576;

/** POLICY-016 fix: Maximum nested object depth. Prevents stack overflow via deeply nested structures. */
const MAX_NESTING_DEPTH = 20;

/** POLICY-016 fix: Recursively check nesting depth of a parsed object. */
function checkDepth(value: unknown, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(
      `Invalid serialized policy: nesting depth exceeds maximum of ${MAX_NESTING_DEPTH}. ` +
      `This may indicate a maliciously crafted payload.`,
    );
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        checkDepth(item, depth + 1);
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        checkDepth((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  }
}

export function deserializePolicy(data: VersionedPolicyConfig): Policy {
  if (data == null || typeof data !== "object") {
    throw new Error("Invalid serialized policy: expected an object");
  }

  // POLICY-016 fix: Enforce size limit on serialized payload
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_SERIALIZED_SIZE) {
    throw new Error(
      `Invalid serialized policy: size ${serialized.length} bytes exceeds maximum of ${MAX_SERIALIZED_SIZE} bytes`,
    );
  }

  // POLICY-016 fix: Enforce nesting depth limit to prevent stack overflow
  checkDepth(data, 0);

  if (!("version" in data) || typeof data.version !== "number") {
    throw new Error(
      "Invalid serialized policy: missing or non-numeric 'version' field. " +
      "This may be a policy serialized before schema versioning was introduced.",
    );
  }

  // L-08 fix: Reject NaN, Infinity, -Infinity, zero, and negative version numbers.
  // typeof NaN === "number" and typeof Infinity === "number" in JavaScript, so the
  // check above alone is insufficient. These non-finite values could bypass the
  // SUPPORTED_VERSIONS.has() check in unexpected ways or cause incorrect behavior
  // in future version migration logic.
  if (!Number.isFinite(data.version) || data.version <= 0) {
    throw new Error("Invalid policy version");
  }

  if (!SUPPORTED_VERSIONS.has(data.version)) {
    throw new Error(
      `Unsupported policy schema version: ${data.version}. ` +
      `Supported versions: ${[...SUPPORTED_VERSIONS].join(", ")}. ` +
      `This policy may have been created by a newer version of the SDK.`,
    );
  }

  if (!data.policy || typeof data.policy !== "object") {
    throw new Error("Invalid serialized policy: missing or invalid 'policy' field");
  }

  // MED-T3-06 fix: Validate that the policy object has a required 'name' field before
  // passing to Policy.fromJSON(). Without this check, a malformed serialized policy
  // (e.g., with name omitted or set to a non-string) could bypass validation and
  // create a Policy with undefined/invalid name, leading to unexpected behavior in
  // policy evaluation, logging, and serialization round-trips.
  const policyObj = data.policy as unknown as Record<string, unknown>;
  if (typeof policyObj.name !== "string" || policyObj.name.trim() === "") {
    throw new Error(
      "Invalid serialized policy: 'policy.name' must be a non-empty string",
    );
  }

  // Version 1: no migrations needed, load directly
  const policy = Policy.fromJSON(data.policy);

  // MED-30 fix: Post-deserialization cross-validation. After all rules are parsed
  // and individually validated, check for obvious conflicts between rules that
  // could indicate misconfigurations. These are emitted as warnings rather than
  // errors because the individual rules are technically valid in isolation.
  validatePolicyConsistency(data.policy);

  return policy;
}

/**
 * MED-30 fix: Cross-validate rule configurations after deserialization.
 * Checks for common misconfigurations that are valid per-rule but conflicting
 * when combined. Emits process warnings for each detected conflict.
 *
 * Detected conflicts:
 * - Spending limits configured for tokens that appear on a deny list (the
 *   spending limit would never be reached because the allowlist rule denies first)
 * - Overlapping time windows within activeHours (could cause confusing behavior
 *   where the same time matches multiple windows)
 * - Approval gate token mismatch with spending limit tokens (the approval gate
 *   threshold may not align with the spending limit's tracked token)
 */
function validatePolicyConsistency(config: PolicyConfig): void {
  // Check 1: Spending limits on denied tokens.
  // If a spending limit is configured for a token that is effectively blocked
  // by a deny address/program list, the spending limit is misleading — the
  // transaction would be denied by the allowlist rule before the spending limit
  // is ever checked. While not a direct security issue (deny wins), it suggests
  // a misconfiguration that the operator should be aware of.
  if (config.spendingLimit && config.denyPrograms && config.denyPrograms.length > 0) {
    const spendingTokens = getSpendingLimitTokens(config.spendingLimit);
    for (const token of spendingTokens) {
      const normalizedToken = normalizeTokenId(token);
      for (const denied of config.denyPrograms) {
        if (normalizeTokenId(denied) === normalizedToken) {
          process.emitWarning(
            `Policy "${config.name}": spending limit configured for token "${token}" which is also in denyPrograms. ` +
            `The spending limit is unreachable — transactions with this token will be denied by the allowlist rule.`,
            { code: "KOVA_POLICY_CONSISTENCY_WARNING" },
          );
        }
      }
    }
  }

  // Check 2: Overlapping time windows.
  // If two windows in activeHours share a day and their time ranges overlap,
  // the behavior is technically correct (a time matching either window is allowed)
  // but suggests misconfiguration, especially if the operator intended exclusive windows.
  if (config.activeHours && config.activeHours.windows.length > 1) {
    const windows = config.activeHours.windows;
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const w1 = windows[i]!;
        const w2 = windows[j]!;
        // Check if any days overlap
        const days1 = new Set(w1.days);
        const sharedDays = w2.days.filter((d) => days1.has(d));
        if (sharedDays.length > 0) {
          // Check if time ranges overlap
          if (timeRangesOverlap(w1.start, w1.end, w2.start, w2.end)) {
            process.emitWarning(
              `Policy "${config.name}": activeHours windows ${i} (${w1.start}-${w1.end}) and ${j} (${w2.start}-${w2.end}) ` +
              `overlap on days [${sharedDays.join(", ")}]. This may be intentional but could indicate misconfiguration.`,
              { code: "KOVA_POLICY_CONSISTENCY_WARNING" },
            );
          }
        }
      }
    }
  }

  // Check 3: Approval gate token vs spending limit token mismatch.
  // If an approval gate is configured for token X but spending limits only cover
  // token Y, the operator may have a blind spot — large transactions in token Y
  // won't trigger the approval gate, and transactions in token X won't be tracked
  // by spending limits.
  if (config.approvalGate && config.spendingLimit) {
    const gateToken = normalizeTokenId(config.approvalGate.above.token);
    const spendingTokens = getSpendingLimitTokens(config.spendingLimit).map(normalizeTokenId);
    if (spendingTokens.length > 0 && !spendingTokens.includes(gateToken)) {
      process.emitWarning(
        `Policy "${config.name}": approval gate is configured for token "${config.approvalGate.above.token}" ` +
        `but spending limits cover different tokens [${spendingTokens.join(", ")}]. ` +
        `Large transactions in the spending-limit tokens won't trigger approval, and ` +
        `approval-gated token transactions won't be tracked by spending limits.`,
        { code: "KOVA_POLICY_CONSISTENCY_WARNING" },
      );
    }
  }
}

/** Extract all token identifiers referenced in spending limit config */
function getSpendingLimitTokens(limit: NonNullable<PolicyConfig["spendingLimit"]>): string[] {
  const tokens: string[] = [];
  if (limit.perTransaction) tokens.push(limit.perTransaction.token);
  if (limit.daily) tokens.push(limit.daily.token);
  if (limit.weekly) tokens.push(limit.weekly.token);
  if (limit.monthly) tokens.push(limit.monthly.token);
  // Deduplicate
  return [...new Set(tokens)];
}

/** Check if two HH:MM time ranges overlap (assuming same day) */
function timeRangesOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
  const toMinutes = (t: string): number => {
    const parts = t.split(":").map(Number);
    const h = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    return h * 60 + m;
  };
  const s1 = toMinutes(start1);
  const e1 = toMinutes(end1);
  const s2 = toMinutes(start2);
  const e2 = toMinutes(end2);
  // Two ranges [s1,e1) and [s2,e2) overlap if s1 < e2 && s2 < e1
  return s1 < e2 && s2 < e1;
}
