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

  /**
   * Load a policy from a JSON configuration. Validates the config before constructing.
   *
   * M-08 fix: Sanitize input by stripping prototype pollution vectors (__proto__,
   * constructor) before validation. JSON.parse(JSON.stringify()) produces a clean
   * object, then we explicitly delete dangerous keys to prevent prototype pollution
   * attacks when deserializing untrusted policy JSON.
   */
  static fromJSON(json: PolicyConfig): Policy {
    const sanitized = JSON.parse(JSON.stringify(json));
    // Strip prototype pollution vectors recursively
    stripDangerousKeys(sanitized);
    PolicyBuilder.validateConfig(sanitized);
    return new Policy(structuredClone(sanitized));
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

    // POLICY-012 fix: Require at least one rule to be configured. A policy with
    // no rules would silently allow all transactions, violating deny-by-default.
    const hasAnyRule =
      config.rateLimit !== undefined ||
      config.spendingLimit !== undefined ||
      (config.allowAddresses !== undefined && config.allowAddresses.length > 0) ||
      (config.denyAddresses !== undefined && config.denyAddresses.length > 0) ||
      (config.allowPrograms !== undefined && config.allowPrograms.length > 0) ||
      (config.denyPrograms !== undefined && config.denyPrograms.length > 0) ||
      config.activeHours !== undefined ||
      config.approvalGate !== undefined ||
      config.cooldown !== undefined;
    if (!hasAnyRule) {
      throw new Error("Policy must configure at least one rule");
    }

    // M-10 fix: Validate array elements in address and program lists.
    // Ensure each element is a non-empty string to prevent undefined, null, numeric,
    // or empty string entries from silently passing through and causing unexpected
    // behavior in allowlist/denylist rule evaluation.
    if (config.allowAddresses) {
      for (const addr of config.allowAddresses) {
        if (typeof addr !== "string" || addr.trim().length === 0) {
          throw new Error("allowAddresses must contain non-empty strings");
        }
      }
    }
    if (config.denyAddresses) {
      for (const addr of config.denyAddresses) {
        if (typeof addr !== "string" || addr.trim().length === 0) {
          throw new Error("denyAddresses must contain non-empty strings");
        }
      }
    }
    if (config.allowPrograms) {
      for (const prog of config.allowPrograms) {
        if (typeof prog !== "string" || prog.trim().length === 0) {
          throw new Error("allowPrograms must contain non-empty strings");
        }
      }
    }
    if (config.denyPrograms) {
      for (const prog of config.denyPrograms) {
        if (typeof prog !== "string" || prog.trim().length === 0) {
          throw new Error("denyPrograms must contain non-empty strings");
        }
      }
    }

    // P-13 fix: Validate keyPrefix values to prevent injection of store key delimiters
    // or other unexpected characters that could cause cross-wallet counter collisions.
    if (config.spendingLimit?.keyPrefix && !/^[a-zA-Z0-9_\-:]+$/.test(config.spendingLimit.keyPrefix)) {
      throw new Error('Invalid spending limit keyPrefix');
    }
    if (config.rateLimit?.keyPrefix && !/^[a-zA-Z0-9_\-:]+$/.test(config.rateLimit.keyPrefix)) {
      throw new Error('Invalid rate limit keyPrefix');
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
      // LOW-19 FIX: Reject cooldown config since no CooldownRule implementation exists.
      // Previously this emitted a warning, but a config that silently does nothing is
      // dangerous — operators may believe they have cooldown protection when they don't.
      throw new Error(
        "PolicyBuilder: 'cooldown' is configured but no CooldownRule implementation exists. " +
        "This setting would have no effect. Remove the cooldown config, or implement a " +
        "custom CooldownRule and add it to your PolicyEngine directly.",
      );
    }

    // M4 fix: Warn if the policy has only deny rules but no positive/constraining rules.
    // A deny-only policy allows everything not explicitly denied, which is likely
    // overly permissive. Positive rules include spending limits, rate limits,
    // time windows, approval gates, and allowlists — these constrain what is allowed.
    const hasDenyRule =
      (config.denyAddresses !== undefined && config.denyAddresses.length > 0) ||
      (config.denyPrograms !== undefined && config.denyPrograms.length > 0);
    const hasPositiveRule =
      config.spendingLimit !== undefined ||
      config.rateLimit !== undefined ||
      config.activeHours !== undefined ||
      config.approvalGate !== undefined ||
      (config.allowAddresses !== undefined && config.allowAddresses.length > 0) ||
      (config.allowPrograms !== undefined && config.allowPrograms.length > 0);
    if (hasDenyRule && !hasPositiveRule) {
      process.emitWarning(
        `Policy "${config.name}" has deny rules but no positive rules (spending limit, rate limit, ` +
        `time window, approval gate, or allowlist). This policy allows all transactions that are ` +
        `not explicitly denied, which may be overly permissive.`,
        { code: "KOVA_POLICY_DENY_ONLY_WARNING" },
      );
    }

    // Validate no overlap between allow and deny lists.
    //
    // M-04 fix: Use exact (case-sensitive) comparison by default. Solana addresses
    // are base58-encoded and case-sensitive — lowercasing would conflate distinct
    // addresses (e.g., "ABC" and "abc" are different Solana addresses). EVM addresses
    // (hex, 0x-prefixed) are case-insensitive per EIP-55 checksum, but exact comparison
    // is still safe for overlap detection: if an operator uses different casings for the
    // same EVM address in allow vs deny lists, the overlap will not be detected, but
    // the stricter behavior (deny wins in AllowlistRule) is the safe default. For
    // EVM-specific deployments requiring case-insensitive overlap detection, normalize
    // addresses to lowercase before passing them to the policy builder.
    if (config.allowAddresses && config.denyAddresses) {
      const denySet = new Set(config.denyAddresses);
      const overlap = config.allowAddresses.filter((a) => denySet.has(a));
      if (overlap.length > 0) {
        throw new Error(`Address appears in both allow and deny lists: ${overlap[0]}`);
      }
    }

    if (config.allowPrograms && config.denyPrograms) {
      const denyProgramSet = new Set(config.denyPrograms);
      const overlap = config.allowPrograms.filter((p) => denyProgramSet.has(p));
      if (overlap.length > 0) {
        throw new Error(`Program appears in both allow and deny lists: ${overlap[0]}`);
      }
    }
  }

  private static validateTokenAmount(amount: TokenAmount, label: string): void {
    // M-14 fix: Reject scientific notation in amount strings. Scientific notation
    // (e.g., "1e18", "5E-3") can represent extremely large or small values that
    // bypass practical limits. Require explicit decimal notation for clarity and
    // to prevent accidental misconfiguration of spending limits.
    if (/[eE]/.test(amount.amount)) {
      throw new Error(`${label} amount must not use scientific notation: ${amount.amount}`);
    }
    // AUDIT-L-3: Reject trailing garbage that parseFloat silently ignores (e.g. "1.5abc").
    // Only allow digits with optional decimal point — rejects negatives, "abc", "10abc", etc.
    if (!/^\d+(\.\d+)?$/.test(amount.amount)) {
      throw new Error(`Invalid ${label} amount: ${amount.amount}`);
    }
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

    // MED-06 fix: Validate USD-denominated limit fields. Their amount strings must
    // parse to valid positive finite numbers to prevent silently disabled limits.
    const usdFields: Array<{ value: { amount: string } | undefined; label: string }> = [
      { value: limit.perTransactionUSD, label: "perTransactionUSD" },
      { value: limit.dailyUSD, label: "dailyUSD" },
      { value: limit.weeklyUSD, label: "weeklyUSD" },
      { value: limit.monthlyUSD, label: "monthlyUSD" },
    ];
    for (const { value, label } of usdFields) {
      if (value) {
        const parsed = parseFloat(value.amount);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid spending limit ${label} amount: "${value.amount}" — must be a valid positive finite number`,
          );
        }
      }
    }
  }

  private static validateActiveHours(config: ActiveHoursConfig): void {
    if (!config.timezone) {
      throw new Error("Active hours timezone is required");
    }
    // AUDIT-L-5: Validate outsideHoursPolicy enum values to reject typos/invalid strings.
    if (config.outsideHoursPolicy && !["deny", "require_approval"].includes(config.outsideHoursPolicy)) {
      throw new Error("outsideHoursPolicy must be 'deny' or 'require_approval'");
    }
    if (!config.windows || config.windows.length === 0) {
      throw new Error("At least one active hours window is required");
    }
    for (const window of config.windows) {
      if (!window.days || window.days.length === 0) {
        throw new Error("Active hours window must specify at least one day");
      }
      // LOW-17 fix: Validate day strings at runtime to catch typos like "monday" or "Mo"
      const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
      for (const day of window.days) {
        if (!VALID_DAYS.has(day)) {
          throw new Error(`Invalid day "${day}" in time window. Must be one of: mon, tue, wed, thu, fri, sat, sun`);
        }
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
    // POLICY-021 fix: Validate timeout is a positive finite number. Previously only
    // rejected <= 0, but NaN/Infinity would pass through. Now consistent with rule behavior.
    if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout <= 0)) {
      throw new Error("Approval gate timeout must be a positive finite number (milliseconds)");
    }
    // HIGH-08 fix: Validate cumulativeWindow is a positive finite number (seconds)
    if (config.cumulativeWindow !== undefined && (typeof config.cumulativeWindow !== "number" || !Number.isFinite(config.cumulativeWindow) || config.cumulativeWindow <= 0)) {
      throw new Error("Approval gate cumulativeWindow must be a positive finite number (seconds)");
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
}

/**
 * M-08 fix: Recursively strip dangerous keys (__proto__, constructor, prototype)
 * from an object to prevent prototype pollution attacks during deserialization.
 * These keys can be injected into JSON payloads to modify Object.prototype,
 * potentially compromising all objects in the runtime.
 *
 * MED-T4-07 NOTE: This function is intentional defense-in-depth, not redundancy.
 * While the JSON.parse(JSON.stringify()) round-trip in fromJSON() already strips
 * non-serializable properties (functions, symbols, undefined, circular refs) and
 * produces a clean POJO, it does NOT remove __proto__ keys from JSON payloads.
 * JSON.parse('{"__proto__": {"polluted": true}}') creates an object with an own
 * property named "__proto__" that can be exploited during property enumeration or
 * Object.assign/spread operations. This explicit stripping ensures that even if
 * the JSON round-trip behavior changes in a future engine, or if the sanitized
 * object is later passed to a library that is vulnerable to prototype pollution,
 * the dangerous keys are definitively removed. Defense-in-depth: both layers must
 * fail for prototype pollution to succeed.
 */
// AUDIT-L-6: Does not cover toString/valueOf. Low risk as JSON.parse prevents function injection.
function stripDangerousKeys(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      stripDangerousKeys(item);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  delete record["__proto__"];
  delete record["constructor"];
  delete record["prototype"];

  for (const key of Object.keys(record)) {
    if (typeof record[key] === "object" && record[key] !== null) {
      stripDangerousKeys(record[key]);
    }
  }
}
