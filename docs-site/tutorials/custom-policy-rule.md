# Building a Custom Policy Rule

---

## What You'll Build

In this tutorial, you'll build a custom policy rule from scratch -- a **Recipient Reputation Rule** that checks recipient addresses against a blocklist before allowing transfers. By the end, you will understand how the policy engine works internally and be able to create any custom rule for your agent's specific needs.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |

You should have a working kova project. If you followed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial, you are ready to go.

---

## Step 1: Understand the PolicyRule Interface

Every policy rule in kova implements this interface:

```typescript
interface PolicyRule {
  /** Unique name for this rule (used in audit logs and error messages) */
  name: string;
  /** Evaluate the intent against this rule */
  evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision>;
}
```

The `evaluate()` method receives two arguments:

| Argument | What it contains |
|----------|-----------------|
| `intent` | The transaction the agent wants to execute -- includes `type` (transfer, swap, mint, stake, custom), `chain`, `params`, and optional `metadata` |
| `context` | The SDK context -- includes `store` (for persisting data), `approval` (for human-in-the-loop channels), and `now` (current timestamp, injectable for testing) |

And it must return one of three decisions:

| Decision | Meaning | What happens next |
|----------|---------|-------------------|
| `ALLOW` | This rule has no objection | The engine moves to the next rule |
| `DENY` | This rule blocks the transaction | The engine stops immediately and rejects the intent |
| `PENDING` | This rule requires human approval | The engine pauses and waits for the approval channel |

::: tip FAIL-CLOSED DESIGN
If your `evaluate()` method throws an error, the `PolicyEngine` catches it and treats it as a `DENY`. This is intentional -- a broken rule should block transactions, not silently allow them. You do not need to wrap your logic in try/catch unless you want to handle specific errors differently.
:::

---

## Step 2: Plan the Rule

Our **Recipient Reputation Rule** will:

1. Extract the recipient address from transfer intents
2. Check the address against a cached blocklist stored in the SDK's `Store`
3. Optionally fetch fresh reputation data from an external API (with caching to avoid rate limits)
4. **DENY** transfers to known-bad addresses
5. **ALLOW** everything else (including non-transfer intents that have no recipient)

This covers a real-world use case: preventing your AI agent from sending funds to known scam addresses, sanctioned wallets, or addresses flagged by on-chain analytics providers.

---

## Step 3: Create the File

Create a new file for your custom rule:

```bash
touch recipient-reputation-rule.ts
```

Add the imports:

```typescript
// Import the types your rule needs to implement.
// PolicyRule is the interface, PolicyDecision is the return type,
// and PolicyContext gives access to the store and current time.
import type {
  PolicyRule,
  PolicyDecision,
  PolicyContext,
} from "kova";

// TransactionIntent is the structured description of what the agent wants to do.
import type { TransactionIntent } from "kova";
```

---

## Step 4: Define the Configuration

Your rule needs configuration -- at minimum, a list of blocked addresses. We also add an optional external lookup function for dynamic reputation checks.

```typescript
/** Reputation lookup result from an external API */
export interface ReputationResult {
  /** Whether the address is flagged as malicious */
  isMalicious: boolean;
  /** Human-readable reason (e.g., "OFAC sanctioned", "Known phishing address") */
  reason?: string;
  /** Risk score from 0 (safe) to 100 (dangerous) */
  riskScore: number;
}

/** Configuration for the Recipient Reputation Rule */
export interface RecipientReputationConfig {
  /** Static list of known-bad addresses to block immediately */
  blockedAddresses?: string[];

  /** Risk score threshold (0-100). Addresses at or above this score are blocked.
   *  Default: 80 */
  riskThreshold?: number;

  /** Optional async function that checks an address against an external reputation API.
   *  If not provided, only the static blocklist is used. */
  lookupReputation?: (address: string) => Promise<ReputationResult>;

  /** How long to cache external reputation results, in seconds. Default: 3600 (1 hour) */
  cacheTtlSeconds?: number;
}
```

::: details Why separate static blocklist from dynamic lookup?
The static blocklist is fast and works offline -- it is checked first. The dynamic lookup is for integrating with services like Chainalysis, Elliptic, or your own reputation database. By making the lookup function a config parameter, your rule works with any reputation provider without hard-coding a dependency.
:::

---

## Step 5: Implement the Rule Class

Now build the class that implements `PolicyRule`:

```typescript
export class RecipientReputationRule implements PolicyRule {
  // The name appears in audit logs, denial messages, and error reports.
  readonly name = "recipient-reputation";

  // Internal state derived from config.
  private readonly blockedAddresses: Set<string>;
  private readonly riskThreshold: number;
  private readonly lookupReputation?: (address: string) => Promise<ReputationResult>;
  private readonly cacheTtlSeconds: number;

  // Store key prefix to namespace our cached reputation data.
  private readonly cachePrefix = "reputation:";

  constructor(config: RecipientReputationConfig) {
    this.blockedAddresses = new Set(config.blockedAddresses ?? []);
    this.riskThreshold = config.riskThreshold ?? 80;
    this.lookupReputation = config.lookupReputation;
    this.cacheTtlSeconds = config.cacheTtlSeconds ?? 3600;
  }

  async evaluate(
    intent: TransactionIntent,
    context: PolicyContext,
  ): Promise<PolicyDecision> {
    // Step 1: Extract the recipient address.
    // Only transfer intents have a "to" field. Other intent types
    // (swap, mint, stake, custom) are allowed through -- this rule
    // only cares about where funds are being sent.
    const recipient = this.extractRecipient(intent);
    if (!recipient) {
      return { decision: "ALLOW" };
    }

    // Step 2: Check the static blocklist (instant, no I/O).
    if (this.blockedAddresses.has(recipient)) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Recipient is on the static blocklist: ${recipient}`,
      };
    }

    // Step 3: Check cached reputation (if external lookup is configured).
    if (this.lookupReputation) {
      const reputation = await this.getReputation(recipient, context);
      if (reputation && reputation.isMalicious) {
        return {
          decision: "DENY",
          rule: this.name,
          reason: reputation.reason
            ?? `Recipient has a risk score of ${reputation.riskScore} (threshold: ${this.riskThreshold})`,
        };
      }
    }

    // Step 4: All checks passed.
    return { decision: "ALLOW" };
  }

  /** Extract the recipient address from a transfer intent */
  private extractRecipient(intent: TransactionIntent): string | null {
    if (intent.type !== "transfer") return null;
    const params = intent.params as { to?: string };
    return params.to ?? null;
  }

  /** Look up reputation with caching via the SDK store */
  private async getReputation(
    address: string,
    context: PolicyContext,
  ): Promise<ReputationResult | null> {
    const cacheKey = this.cachePrefix + address;

    // Check cache first to avoid hammering the external API.
    const cached = await context.store.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as ReputationResult;
    }

    // Cache miss -- call the external lookup.
    try {
      const result = await this.lookupReputation!(address);

      // Cache the result with TTL so we don't look up the same address repeatedly.
      await context.store.set(cacheKey, JSON.stringify(result), this.cacheTtlSeconds);

      // Apply the risk threshold.
      if (result.riskScore >= this.riskThreshold) {
        return { ...result, isMalicious: true };
      }
      return result;
    } catch {
      // If the external API is down, fail open for reputation checks.
      // The static blocklist still provides protection.
      // You could change this to fail-closed by returning a DENY here.
      return null;
    }
  }
}
```

::: warning FAIL-OPEN VS FAIL-CLOSED
In the code above, if the external reputation API is unreachable, the rule **fails open** (allows the transaction). This is a deliberate choice: the static blocklist still provides baseline protection, and you do not want a flaky API to freeze your agent entirely. If your use case requires maximum safety, change the `catch` block to return a `DENY` result instead.
:::

---

## Step 6: Wire It Into the PolicyEngine

Add your custom rule to the rule array alongside the built-in rules:

```typescript
import {
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
  MemoryStore,
} from "kova";
import { RecipientReputationRule } from "./recipient-reputation-rule";

const store = new MemoryStore(); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1

// Create the rules array. Rules are evaluated in order --
// put cheap checks first, expensive checks last.
const rules = [
  // 1. Rate limit (stateless, instant)
  new RateLimitRule({ maxTransactionsPerMinute: 10 }),

  // 2. Allowlist (stateless, instant)
  new AllowlistRule({
    denyAddresses: ["KnownScamAddress111111111111111111"],
  }),

  // 3. Recipient reputation (may hit cache or external API)
  new RecipientReputationRule({
    blockedAddresses: [
      "SanctionedAddress11111111111111111",
      "PhishingAddress2222222222222222222",
    ],
    riskThreshold: 75,
    lookupReputation: async (address) => {
      // Replace with your actual reputation API call.
      // Example: Chainalysis, Elliptic, or a custom internal service.
      const response = await fetch(
        `https://api.your-reputation-service.com/check/${address}`,
      );
      const data = await response.json();
      return {
        isMalicious: data.flagged,
        reason: data.reason,
        riskScore: data.score,
      };
    },
    cacheTtlSeconds: 1800, // Cache results for 30 minutes
  }),

  // 4. Spending limit (touches the store for counter tracking)
  new SpendingLimitRule({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "20", token: "SOL" },
  }),
];

// Build the engine with all rules.
const engine = new PolicyEngine(rules, store);
```

The `PolicyEngine` evaluates rules in array order and stops at the first `DENY`. Ordering matters for performance:

| Position | Rule | Why here |
|----------|------|----------|
| 1st | Rate limit | Stateless, instant check. Blocks burst attacks before anything else runs. |
| 2nd | Allowlist | Stateless set lookup. Catches known-bad addresses immediately. |
| 3rd | Reputation | May hit cache (fast) or external API (slow). Only runs if earlier checks passed. |
| 4th | Spending limit | Touches the store for counter reads. Only runs if all address checks passed. |

---

## Step 7: Test Your Rule

Here is a test suite using Vitest:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "kova";
import type { PolicyContext, TransactionIntent } from "kova";
import { RecipientReputationRule } from "./recipient-reputation-rule";

// Helper to create a PolicyContext with a fresh store.
function createContext(): PolicyContext {
  return {
    store: new MemoryStore(), // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
    now: Date.now(),
  };
}

// Helper to create a transfer intent.
function transferIntent(to: string, amount = "1.0"): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: { to, amount, token: "SOL" },
  };
}

describe("RecipientReputationRule", () => {
  it("should ALLOW transfers to addresses not on the blocklist", async () => {
    const rule = new RecipientReputationRule({
      blockedAddresses: ["BadAddress1111111111111111111111111"],
    });
    const result = await rule.evaluate(
      transferIntent("SafeAddress22222222222222222222222"),
      createContext(),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY transfers to addresses on the static blocklist", async () => {
    const rule = new RecipientReputationRule({
      blockedAddresses: ["BadAddress1111111111111111111111111"],
    });
    const result = await rule.evaluate(
      transferIntent("BadAddress1111111111111111111111111"),
      createContext(),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("static blocklist");
    }
  });

  it("should ALLOW non-transfer intents (swap, mint, etc.)", async () => {
    const rule = new RecipientReputationRule({
      blockedAddresses: ["BadAddress1111111111111111111111111"],
    });
    const swapIntent: TransactionIntent = {
      type: "swap",
      chain: "solana",
      params: { fromToken: "SOL", toToken: "USDC", amount: "10" },
    };
    const result = await rule.evaluate(swapIntent, createContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when external lookup returns high risk score", async () => {
    const rule = new RecipientReputationRule({
      riskThreshold: 70,
      lookupReputation: vi.fn(async () => ({
        isMalicious: false,
        riskScore: 85,
        reason: "Associated with known exploit",
      })),
    });
    const result = await rule.evaluate(
      transferIntent("SuspiciousAddr333333333333333333333"),
      createContext(),
    );
    expect(result.decision).toBe("DENY");
  });

  it("should ALLOW when external lookup returns low risk score", async () => {
    const rule = new RecipientReputationRule({
      riskThreshold: 70,
      lookupReputation: vi.fn(async () => ({
        isMalicious: false,
        riskScore: 10,
      })),
    });
    const result = await rule.evaluate(
      transferIntent("SafeAddr44444444444444444444444444444"),
      createContext(),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should cache reputation results in the store", async () => {
    const lookup = vi.fn(async () => ({
      isMalicious: false,
      riskScore: 5,
    }));

    const rule = new RecipientReputationRule({
      lookupReputation: lookup,
      cacheTtlSeconds: 600,
    });

    const context = createContext();
    const intent = transferIntent("CachedAddr555555555555555555555555");

    // First call -- hits the external API.
    await rule.evaluate(intent, context);
    expect(lookup).toHaveBeenCalledTimes(1);

    // Second call -- should use cache, NOT call the API again.
    await rule.evaluate(intent, context);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("should fail open when external API throws", async () => {
    const rule = new RecipientReputationRule({
      lookupReputation: vi.fn(async () => {
        throw new Error("API unreachable");
      }),
    });
    const result = await rule.evaluate(
      transferIntent("UnknownAddr666666666666666666666666"),
      createContext(),
    );
    // Fail-open: allow when reputation API is down.
    expect(result.decision).toBe("ALLOW");
  });

  it("should check static blocklist before external lookup", async () => {
    const lookup = vi.fn(async () => ({
      isMalicious: false,
      riskScore: 0,
    }));

    const rule = new RecipientReputationRule({
      blockedAddresses: ["BlockedAddr777777777777777777777777"],
      lookupReputation: lookup,
    });

    const result = await rule.evaluate(
      transferIntent("BlockedAddr777777777777777777777777"),
      createContext(),
    );
    expect(result.decision).toBe("DENY");
    // The external API should NOT have been called --
    // static blocklist short-circuits.
    expect(lookup).not.toHaveBeenCalled();
  });
});
```

---

## Other Rule Ideas

The same pattern works for any custom logic. Here are a few ideas:

| Rule | Evaluate logic |
|------|----------------|
| **Geofence Rule** | Deny transactions outside allowed regions (check `context.now` + timezone) |
| **Token Whitelist** | Only allow transfers of approved tokens (check `params.token`) |
| **Max Recipients Per Day** | Use `context.store.increment()` to count unique recipients per 24h window |
| **AI Confidence Gate** | Read `metadata.confidence` from the intent and deny below a threshold |
| **Cooldown Rule** | After a large transaction, require a waiting period before the next one (use `context.store.set()` with TTL) |

All of these follow the same structure: implement `PolicyRule`, return `ALLOW` / `DENY` / `PENDING`, and optionally use the store for stateful tracking.

---

## Summary

Building a custom policy rule takes three steps:

1. **Implement `PolicyRule`** -- one `name` property and one `evaluate()` method
2. **Return a decision** -- `ALLOW`, `DENY` (with `rule` and `reason`), or `PENDING` (with `approvalRequestId`)
3. **Add it to the rules array** -- the `PolicyEngine` handles the rest

The rule has access to the full `TransactionIntent` (what the agent wants to do) and the `PolicyContext` (the store for persistence, the approval channel, and the current time). This is enough to implement virtually any safety constraint.

---

## See Also

- [Policy Engine](/guide/policy-engine) -- how the engine evaluates rules and produces audit trails
- [Policy Cookbook](/tutorials/policy-cookbook) -- common policy configurations using built-in rules
- [Transaction Intents](/guide/intents) -- the intent types your rule receives
- [Stores](/guide/stores) -- the persistence layer your rule can use via `context.store`
