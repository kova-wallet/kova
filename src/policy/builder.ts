/**
 * Policy Builder — Fluent API for constructing policies with type safety.
 * Serializes to/from JSON for storage and transmission.
 */

import type {
  PolicyConfig,
  SpendingLimitConfig,
  RateLimitConfig,
  ActiveHoursConfig,
  ApprovalGateConfig,
  CooldownConfig,
  TokenAmount,
} from "./types.js";

export class Policy {
  private readonly config: PolicyConfig;

  private constructor(config: PolicyConfig) {
    this.config = config;
  }

  /** Create a new policy with the given name */
  static create(name: string): PolicyBuilder {
    return new PolicyBuilder(name);
  }

  /** Load a policy from a JSON configuration. Validates the config before constructing. */
  static fromJSON(json: PolicyConfig): Policy {
    PolicyBuilder.validateConfig(json);
    return new Policy(structuredClone(json));
  }

  /** Extend an existing policy with overrides */
  static extend(base: Policy, name: string): PolicyBuilder {
    const builder = new PolicyBuilder(name);
    builder.setBaseConfig(base.config);
    return builder;
  }

  /** Serialize the policy to JSON (deep copy — safe to mutate) */
  toJSON(): PolicyConfig {
    return structuredClone(this.config);
  }

  /** Get the policy name */
  getName(): string {
    return this.config.name;
  }

  /** Get the full configuration (deep copy — safe to mutate) */
  getConfig(): Readonly<PolicyConfig> {
    return structuredClone(this.config);
  }
}

export class PolicyBuilder {
  private config: PolicyConfig;

  constructor(name: string) {
    this.config = { name };
  }

  /** Used internally by Policy.extend() */
  setBaseConfig(base: PolicyConfig): void {
    this.config = { ...structuredClone(base), name: this.config.name };
  }

  /** Configure spending limits */
  spendingLimit(limits: SpendingLimitConfig): this {
    this.config.spendingLimit = limits;
    return this;
  }

  /** Set allowlisted recipient addresses */
  allowAddresses(addresses: string[]): this {
    this.config.allowAddresses = [...addresses];
    return this;
  }

  /** Set denylisted addresses */
  denyAddresses(addresses: string[]): this {
    this.config.denyAddresses = [...addresses];
    return this;
  }

  /** Set allowlisted program/contract IDs */
  allowPrograms(programs: string[]): this {
    this.config.allowPrograms = [...programs];
    return this;
  }

  /** Set denylisted program/contract IDs */
  denyPrograms(programs: string[]): this {
    this.config.denyPrograms = [...programs];
    return this;
  }

  /** Configure rate limits */
  rateLimit(config: RateLimitConfig): this {
    this.config.rateLimit = config;
    return this;
  }

  /** Configure active hours */
  activeHours(config: ActiveHoursConfig): this {
    this.config.activeHours = config;
    return this;
  }

  /** Configure human approval requirement */
  requireApproval(config: ApprovalGateConfig): this {
    this.config.approvalGate = config;
    return this;
  }

  /** Configure cooldown after large transactions */
  cooldown(config: CooldownConfig): this {
    this.config.cooldown = config;
    return this;
  }

  /** Build the policy. Validates configuration. */
  build(): Policy {
    PolicyBuilder.validateConfig(this.config);
    return Policy.fromJSON(this.config);
  }

  /** Validate a policy config. Used by both build() and fromJSON(). */
  static validateConfig(config: PolicyConfig): void {
    if (!config.name || config.name.trim().length === 0) {
      throw new Error("Policy name is required");
    }

    if (config.spendingLimit) {
      PolicyBuilder.validateSpendingLimit(config.spendingLimit);
    }

    if (config.activeHours) {
      PolicyBuilder.validateActiveHours(config.activeHours);
    }

    if (config.approvalGate) {
      PolicyBuilder.validateApprovalGate(config.approvalGate);
    }

    if (config.rateLimit) {
      PolicyBuilder.validateRateLimit(config.rateLimit);
    }

    if (config.cooldown) {
      PolicyBuilder.validateCooldown(config.cooldown);
    }

    // Validate no overlap between allow and deny lists
    if (config.allowAddresses && config.denyAddresses) {
      const overlap = config.allowAddresses.filter((a) => config.denyAddresses!.includes(a));
      if (overlap.length > 0) {
        throw new Error(`Address appears in both allow and deny lists: ${overlap[0]}`);
      }
    }

    if (config.allowPrograms && config.denyPrograms) {
      const overlap = config.allowPrograms.filter((p) => config.denyPrograms!.includes(p));
      if (overlap.length > 0) {
        throw new Error(`Program appears in both allow and deny lists: ${overlap[0]}`);
      }
    }
  }

  private static validateTokenAmount(amount: TokenAmount, label: string): void {
    const parsed = parseFloat(amount.amount);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid ${label} amount: ${amount.amount}`);
    }
    if (!amount.token || amount.token.trim().length === 0) {
      throw new Error(`${label} token is required`);
    }
  }

  private static validateSpendingLimit(limit: SpendingLimitConfig): void {
    const fields = [limit.perTransaction, limit.daily, limit.weekly, limit.monthly];
    for (const field of fields) {
      if (field) {
        PolicyBuilder.validateTokenAmount(field, "Spending limit");
      }
    }
  }

  private static validateActiveHours(config: ActiveHoursConfig): void {
    if (!config.timezone) {
      throw new Error("Active hours timezone is required");
    }
    if (!config.windows || config.windows.length === 0) {
      throw new Error("At least one active hours window is required");
    }
    for (const window of config.windows) {
      if (!window.days || window.days.length === 0) {
        throw new Error("Active hours window must specify at least one day");
      }
      const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!timeRegex.test(window.start)) {
        throw new Error(`Invalid start time format: ${window.start} (expected HH:MM)`);
      }
      if (!timeRegex.test(window.end)) {
        throw new Error(`Invalid end time format: ${window.end} (expected HH:MM)`);
      }
    }
  }

  private static validateApprovalGate(config: ApprovalGateConfig): void {
    const amount = parseFloat(config.above.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error(`Invalid approval gate amount: ${config.above.amount}`);
    }
    if (config.timeout !== undefined && config.timeout <= 0) {
      throw new Error("Approval gate timeout must be positive");
    }
  }

  private static validateRateLimit(config: RateLimitConfig): void {
    if (
      config.maxTransactionsPerMinute !== undefined &&
      (!Number.isInteger(config.maxTransactionsPerMinute) || config.maxTransactionsPerMinute <= 0)
    ) {
      throw new Error("Rate limit maxTransactionsPerMinute must be a positive integer");
    }
    if (
      config.maxTransactionsPerHour !== undefined &&
      (!Number.isInteger(config.maxTransactionsPerHour) || config.maxTransactionsPerHour <= 0)
    ) {
      throw new Error("Rate limit maxTransactionsPerHour must be a positive integer");
    }
  }

  private static validateCooldown(config: CooldownConfig): void {
    PolicyBuilder.validateTokenAmount(config.afterTransactionAbove, "Cooldown threshold");
    if (config.waitMinutes <= 0) {
      throw new Error("Cooldown waitMinutes must be positive");
    }
  }
}
