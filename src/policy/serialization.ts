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
export function deserializePolicy(data: VersionedPolicyConfig): Policy {
  if (data == null || typeof data !== "object") {
    throw new Error("Invalid serialized policy: expected an object");
  }

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
  return Policy.fromJSON(data.policy);
}
