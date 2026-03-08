/**
 * Pre-built policy templates for common scenarios.
 *
 * Each template returns a PolicyConfig that can be applied directly
 * or used as a starting point for customization.
 */

import { Policy } from "@kova/policy/builder.js";
import type { PolicyConfig } from "@kova/policy/types.js";

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  category: "conservative" | "moderate" | "defi" | "testing";
  build: () => PolicyConfig;
}

export const policyTemplates: PolicyTemplate[] = [
  {
    id: "conservative",
    name: "Conservative",
    description: "Low limits, approval required for all but tiny transactions. Best for high-value wallets.",
    category: "conservative",
    build: () =>
      Policy.create("conservative")
        .spendingLimit({
          perTransaction: { amount: "0.1", token: "SOL" },
          daily: { amount: "1", token: "SOL" },
        })
        .requireApproval({
          above: { amount: "0.01", token: "SOL" },
          timeout: 120_000,
        })
        .rateLimit({ maxTransactionsPerMinute: 3 })
        .build()
        .toJSON(),
  },
  {
    id: "moderate",
    name: "Moderate",
    description: "Balanced limits suitable for most agent operations. Approval above 1 SOL.",
    category: "moderate",
    build: () =>
      Policy.create("moderate")
        .spendingLimit({
          perTransaction: { amount: "5", token: "SOL" },
          daily: { amount: "20", token: "SOL" },
        })
        .requireApproval({
          above: { amount: "1", token: "SOL" },
          timeout: 120_000,
        })
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build()
        .toJSON(),
  },
  {
    id: "defi-bot",
    name: "DeFi Bot",
    description: "Higher limits for automated DeFi strategies. Rate-limited to prevent runaway loops.",
    category: "defi",
    build: () =>
      Policy.create("defi-bot")
        .spendingLimit({
          perTransaction: { amount: "10", token: "SOL" },
          daily: { amount: "100", token: "SOL" },
        })
        .requireApproval({
          above: { amount: "5", token: "SOL" },
          timeout: 60_000,
        })
        .rateLimit({ maxTransactionsPerMinute: 20 })
        .build()
        .toJSON(),
  },
  {
    id: "business-hours",
    name: "Business Hours Only",
    description: "Transactions only allowed Monday-Friday 9am-5pm UTC. Moderate limits.",
    category: "conservative",
    build: () =>
      Policy.create("business-hours")
        .spendingLimit({
          perTransaction: { amount: "5", token: "SOL" },
          daily: { amount: "20", token: "SOL" },
        })
        .activeHours({
          timezone: "UTC",
          windows: [
            { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
          ],
        })
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build()
        .toJSON(),
  },
  {
    id: "testing",
    name: "Testing / Devnet",
    description: "Generous limits for development and testing. No approval required.",
    category: "testing",
    build: () =>
      Policy.create("testing")
        .spendingLimit({
          perTransaction: { amount: "100", token: "SOL" },
          daily: { amount: "1000", token: "SOL" },
        })
        .rateLimit({ maxTransactionsPerMinute: 30 })
        .build()
        .toJSON(),
  },
  {
    id: "allowlist-only",
    name: "Allowlist Only",
    description: "Only send to pre-approved addresses. Strict per-tx and daily limits.",
    category: "conservative",
    build: () =>
      Policy.create("allowlist-only")
        .spendingLimit({
          perTransaction: { amount: "1", token: "SOL" },
          daily: { amount: "10", token: "SOL" },
        })
        .allowAddresses([]) // User must fill in addresses
        .rateLimit({ maxTransactionsPerMinute: 5 })
        .build()
        .toJSON(),
  },
];

/**
 * Get all available policy templates.
 */
export function getPolicyTemplates(): Omit<PolicyTemplate, "build">[] {
  return policyTemplates.map(({ id, name, description, category }) => ({
    id,
    name,
    description,
    category,
  }));
}

/**
 * Build a policy config from a template ID.
 */
export function buildFromTemplate(templateId: string): PolicyConfig {
  const template = policyTemplates.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(`Unknown policy template: ${templateId}`);
  }
  return template.build();
}
