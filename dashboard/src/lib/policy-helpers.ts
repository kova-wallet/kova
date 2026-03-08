/**
 * Converts a PolicyConfig into an array of PolicyRule instances.
 * Same pattern used in the SDK's examples — no SDK modifications needed.
 */

import type { PolicyConfig, PolicyRule } from "@kova/policy/types.js";
import { SpendingLimitRule } from "@kova/policy/rules/spending-limit.js";
import { AllowlistRule } from "@kova/policy/rules/allowlist.js";
import { RateLimitRule } from "@kova/policy/rules/rate-limit.js";
import { TimeWindowRule } from "@kova/policy/rules/time-window.js";
import { ApprovalGateRule } from "@kova/policy/rules/approval-gate.js";

export function policyConfigToRules(config: PolicyConfig): PolicyRule[] {
  const rules: PolicyRule[] = [];

  // Cheapest rules first (short-circuit early)
  if (config.rateLimit) {
    rules.push(new RateLimitRule(config.rateLimit));
  }

  if (config.activeHours) {
    rules.push(new TimeWindowRule(config.activeHours));
  }

  if (
    config.allowAddresses?.length ||
    config.denyAddresses?.length ||
    config.allowPrograms?.length ||
    config.denyPrograms?.length
  ) {
    rules.push(
      new AllowlistRule({
        allowAddresses: config.allowAddresses,
        denyAddresses: config.denyAddresses,
        allowPrograms: config.allowPrograms,
        denyPrograms: config.denyPrograms,
      })
    );
  }

  if (config.spendingLimit) {
    rules.push(new SpendingLimitRule(config.spendingLimit));
  }

  if (config.approvalGate) {
    rules.push(new ApprovalGateRule(config.approvalGate));
  }

  return rules;
}
