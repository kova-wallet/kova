# Portfolio Rebalancer Agent

---

## What You'll Build

In this tutorial, you'll build an autonomous agent that monitors a portfolio's token allocation and executes swaps to maintain a target balance. By the end you will have:

- A rebalancer that targets 60% SOL / 40% USDC
- A **drift threshold rule** (custom policy rule) that only allows swaps when the portfolio is more than 5% off target
- Time-window restrictions so the agent only rebalances during market hours
- Spending limits and rate limits as safety backstops

This demonstrates the SDK as a safety layer around a fully autonomous agent loop -- the agent decides *when* and *what* to swap, but the policy engine enforces *how much* and *through which programs*.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |

You should have completed the [Your First Agent Wallet](/tutorials/first-wallet) and [DeFi Agent](/tutorials/defi-agent) tutorials.

---

## Architecture

```
  ┌──────────────────────────────────────────────────┐
  │              Rebalancer Agent Loop                │
  │                                                    │
  │  1. Check current portfolio allocation             │
  │  2. Compare to target (60% SOL / 40% USDC)        │
  │  3. If drift > threshold → build swap intent       │
  │  4. Submit intent to wallet.execute()              │
  │                                                    │
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────────┐
  │              AgentWallet (Safety Layer)            │
  │                                                    │
  │  Policy Engine evaluates:                          │
  │    ✓ DriftThresholdRule — is drift > 5%?           │
  │    ✓ TimeWindowRule — is it market hours?           │
  │    ✓ RateLimitRule — max 5 rebalances/hour         │
  │    ✓ AllowlistRule — only Jupiter/Orca programs    │
  │    ✓ SpendingLimitRule — max 50 SOL/day in swaps   │
  │                                                    │
  │  If all rules pass → build tx → sign → broadcast   │
  └──────────────────────────────────────────────────┘
```

The key insight: the **agent decides** to rebalance, but the **policy engine validates** that the rebalance is safe. This separation means a bug in the agent's logic cannot drain the wallet -- the policy rules are an independent safety layer.

---

## Step 1: Define the Portfolio Target

```typescript
import {
  AgentWallet,
  LocalSigner,
  SqliteStore,
  SolanaAdapter,
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
  TimeWindowRule,
  AuditLogger,
} from "@kova/wallet";
import type { PolicyRule, PolicyDecision, PolicyContext, TransactionIntent } from "@kova/wallet";
import { Keypair } from "@solana/web3.js";

// ── Portfolio Configuration ─────────────────────────────────────────────────

/** Target allocation as percentages (must sum to 1.0) */
const TARGET_ALLOCATION = {
  SOL: 0.6,   // 60% in SOL
  USDC: 0.4,  // 40% in USDC
} as const;

/** Minimum drift percentage before a rebalance is triggered */
const DRIFT_THRESHOLD = 0.05; // 5%

/** How often to check the portfolio (in milliseconds) */
const CHECK_INTERVAL_MS = 60_000; // Every 60 seconds

/** USDC mint address on Solana */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
```

---

## Step 2: Build a Custom Drift Threshold Rule

This custom policy rule ensures the agent only swaps when the portfolio has actually drifted beyond the threshold. Without this, the agent could swap tiny amounts back and forth, wasting fees.

```typescript
/**
 * DriftThresholdRule — Only allows swap intents when the portfolio
 * has drifted more than a configured percentage from its target allocation.
 *
 * This prevents unnecessary micro-rebalances that waste transaction fees.
 * The drift value is passed in the intent's metadata by the agent loop.
 */
class DriftThresholdRule implements PolicyRule {
  readonly name = "drift-threshold";
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  async evaluate(intent: TransactionIntent, _context: PolicyContext): Promise<PolicyDecision> {
    // Only apply to swap intents. Allow all other intent types through.
    if (intent.type !== "swap") {
      return { decision: "ALLOW" };
    }

    // The agent loop attaches the current drift to intent metadata.
    // If no drift is provided, deny the swap as a safety measure.
    const drift = intent.metadata?.reason?.match(/drift: ([\d.]+)%/);
    if (!drift) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Swap intent missing drift information in metadata. Include drift percentage in the reason field.",
      };
    }

    const driftPercent = parseFloat(drift[1]) / 100;
    if (driftPercent < this.threshold) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Portfolio drift (${(driftPercent * 100).toFixed(1)}%) is below the ${(this.threshold * 100).toFixed(1)}% threshold. No rebalance needed.`,
      };
    }

    return { decision: "ALLOW" };
  }
}
```

::: tip ALTERNATIVE: STORE-BASED DRIFT TRACKING
Instead of passing drift in metadata, you could have the agent write the current allocation to the store, and the rule reads it directly. The metadata approach shown here is simpler and keeps the rule stateless.
:::

---

## Step 3: Assemble the Policy Engine

```typescript
const store = new SqliteStore({ path: "./rebalancer.db" });

const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});

const keypair = Keypair.generate();
const signer = new LocalSigner(keypair); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1

// Rules in evaluation order: cheapest checks first.
const rules: PolicyRule[] = [
  // 1. Rate limit: max 5 rebalances per hour.
  // This prevents the agent from thrashing if the market is volatile.
  new RateLimitRule({
    maxTransactionsPerMinute: 2,
    maxTransactionsPerHour: 5,
  }),

  // 2. Time window: only rebalance during US market hours.
  // Crypto trades 24/7, but limiting to market hours reduces risk
  // from low-liquidity periods and overnight flash crashes.
  new TimeWindowRule({
    timezone: "America/New_York",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "08:00",
        end: "20:00",
      },
    ],
    outsideHoursPolicy: "deny",
  }),

  // 3. Drift threshold: only swap when drift exceeds 5%.
  // Prevents micro-rebalances that waste fees.
  new DriftThresholdRule(DRIFT_THRESHOLD),

  // 4. Program allowlist: only swap through Jupiter and Orca.
  // Prevents the agent from interacting with unknown swap programs.
  new AllowlistRule({
    allowPrograms: [
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
    ],
  }),

  // 5. Spending limit: max 50 SOL per day in swap volume.
  // Even if the agent goes haywire, it cannot swap more than this.
  new SpendingLimitRule({
    perTransaction: { amount: "20", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  }),
];

const engine = new PolicyEngine(rules, store);
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});
```

---

## Step 4: Build the Rebalancer Logic

This is the core agent loop. It checks balances, calculates drift, and submits swap intents when needed.

```typescript
/** Current portfolio state */
interface PortfolioState {
  solBalance: number;
  usdcBalance: number;
  totalValueUSD: number;
  solAllocation: number; // 0.0 - 1.0
  usdcAllocation: number;
  maxDrift: number; // largest drift from target
}

/** Get the current portfolio state */
async function getPortfolioState(): Promise<PortfolioState> {
  const solBalance = await wallet.getBalance("SOL");
  const usdcBalance = await wallet.getBalance("USDC");

  const solAmount = parseFloat(solBalance.amount);
  const usdcAmount = parseFloat(usdcBalance.amount);

  // For a real agent, fetch SOL/USD price from an oracle or API.
  // Using a placeholder price here for demonstration.
  const solPriceUSD = 150; // Replace with real price feed

  const solValueUSD = solAmount * solPriceUSD;
  const usdcValueUSD = usdcAmount * 1.0; // USDC ≈ $1
  const totalValueUSD = solValueUSD + usdcValueUSD;

  if (totalValueUSD === 0) {
    return {
      solBalance: solAmount,
      usdcBalance: usdcAmount,
      totalValueUSD: 0,
      solAllocation: 0,
      usdcAllocation: 0,
      maxDrift: 0,
    };
  }

  const solAllocation = solValueUSD / totalValueUSD;
  const usdcAllocation = usdcValueUSD / totalValueUSD;

  const solDrift = Math.abs(solAllocation - TARGET_ALLOCATION.SOL);
  const usdcDrift = Math.abs(usdcAllocation - TARGET_ALLOCATION.USDC);
  const maxDrift = Math.max(solDrift, usdcDrift);

  return {
    solBalance: solAmount,
    usdcBalance: usdcAmount,
    totalValueUSD,
    solAllocation,
    usdcAllocation,
    maxDrift,
  };
}

/** Calculate and execute the rebalance swap */
async function rebalance(state: PortfolioState) {
  const driftPercent = (state.maxDrift * 100).toFixed(1);
  console.log(`Portfolio drift: ${driftPercent}% (threshold: ${DRIFT_THRESHOLD * 100}%)`);

  if (state.maxDrift < DRIFT_THRESHOLD) {
    console.log("Within threshold -- no rebalance needed.");
    return;
  }

  // Determine swap direction: which token is overweight?
  if (state.solAllocation > TARGET_ALLOCATION.SOL) {
    // SOL is overweight → sell SOL for USDC
    const excessSOL = state.solAllocation - TARGET_ALLOCATION.SOL;
    const swapAmountUSD = excessSOL * state.totalValueUSD;
    const solPriceUSD = 150; // Use real price feed
    const swapAmountSOL = (swapAmountUSD / solPriceUSD).toFixed(4);

    console.log(`Selling ${swapAmountSOL} SOL for USDC to rebalance...`);

    const result = await wallet.execute({
      type: "swap",
      chain: "solana",
      params: {
        fromToken: "SOL",
        toToken: USDC_MINT,
        amount: swapAmountSOL,
        maxSlippage: 0.005, // 0.5% max slippage
      },
      metadata: {
        agentId: "portfolio-rebalancer",
        reason: `Rebalancing: SOL overweight, drift: ${driftPercent}%`,
      },
    });

    logResult("SOL → USDC", result);
  } else {
    // USDC is overweight → sell USDC for SOL
    const excessUSDC = state.usdcAllocation - TARGET_ALLOCATION.USDC;
    const swapAmountUSD = excessUSDC * state.totalValueUSD;
    const swapAmountUSDC = swapAmountUSD.toFixed(2);

    console.log(`Selling ${swapAmountUSDC} USDC for SOL to rebalance...`);

    const result = await wallet.execute({
      type: "swap",
      chain: "solana",
      params: {
        fromToken: USDC_MINT,
        toToken: "SOL",
        amount: swapAmountUSDC,
        maxSlippage: 0.005,
      },
      metadata: {
        agentId: "portfolio-rebalancer",
        reason: `Rebalancing: USDC overweight, drift: ${driftPercent}%`,
      },
    });

    logResult("USDC → SOL", result);
  }
}

function logResult(direction: string, result: { status: string; txId?: string; error?: { message: string } }) {
  if (result.status === "confirmed") {
    console.log(`  ${direction} swap confirmed: ${result.txId}`);
  } else if (result.status === "denied") {
    console.log(`  ${direction} swap denied: ${result.error?.message}`);
  } else {
    console.log(`  ${direction} swap failed: ${result.error?.message}`);
  }
}
```

---

## Step 5: Run the Agent Loop

```typescript
async function main() {
  const address = await wallet.getAddress();
  console.log("Rebalancer wallet:", address);
  console.log(`Target: ${TARGET_ALLOCATION.SOL * 100}% SOL / ${TARGET_ALLOCATION.USDC * 100}% USDC`);
  console.log(`Drift threshold: ${DRIFT_THRESHOLD * 100}%`);
  console.log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log("Starting rebalancer loop...\n");

  // Run the check loop.
  async function tick() {
    try {
      const state = await getPortfolioState();

      console.log(
        `[${new Date().toLocaleTimeString()}] ` +
        `SOL: ${state.solBalance.toFixed(4)} (${(state.solAllocation * 100).toFixed(1)}%) | ` +
        `USDC: ${state.usdcBalance.toFixed(2)} (${(state.usdcAllocation * 100).toFixed(1)}%) | ` +
        `Drift: ${(state.maxDrift * 100).toFixed(1)}%`
      );

      if (state.totalValueUSD > 0 && state.maxDrift >= DRIFT_THRESHOLD) {
        await rebalance(state);
      }
    } catch (err) {
      console.error("Rebalancer error:", err instanceof Error ? err.message : err);
      // Don't crash the loop on transient errors.
    }
  }

  // Initial check.
  await tick();

  // Schedule recurring checks.
  const interval = setInterval(tick, CHECK_INTERVAL_MS);

  // Graceful shutdown.
  const shutdown = () => {
    console.log("\nShutting down rebalancer...");
    clearInterval(interval);
    store.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);
```

**Expected output:**

```
Rebalancer wallet: 7xKXtg...AsU
Target: 60.0% SOL / 40.0% USDC
Drift threshold: 5.0%
Check interval: 60s
Starting rebalancer loop...

[10:30:00] SOL: 5.0000 (75.0%) | USDC: 250.00 (25.0%) | Drift: 15.0%
Portfolio drift: 15.0% (threshold: 5.0%)
Selling 1.0000 SOL for USDC to rebalance...
  SOL → USDC swap confirmed: 5Uj7Kx...abc

[10:31:00] SOL: 4.0000 (62.1%) | USDC: 400.00 (37.9%) | Drift: 2.1%
Within threshold -- no rebalance needed.
```

---

## Step 6: Monitor Rebalancing Activity

```typescript
async function rebalancerReport() {
  const history = await wallet.getTransactionHistory(20);
  const swaps = history.filter((tx) => tx.summary.toLowerCase().includes("swap"));

  console.log("\n═══ Rebalancer Report ═══");
  console.log(`Total rebalances: ${swaps.length}`);
  console.log(`Confirmed: ${swaps.filter((s) => s.status === "confirmed").length}`);
  console.log(`Denied: ${swaps.filter((s) => s.status === "denied").length}`);

  // Check spending against daily limit.
  const dailySpent = await store.get("spending:daily:SOL");
  console.log(`Daily swap volume: ${dailySpent ?? "0"} SOL / 50 SOL limit`);

  console.log("\nRecent activity:");
  for (const swap of swaps.slice(0, 5)) {
    const time = new Date(swap.timestamp).toLocaleTimeString();
    console.log(`  [${time}] [${swap.status}] ${swap.summary}`);
  }
}
```

---

## Safety Analysis

Here is how each policy rule protects the agent:

| Scenario | What could go wrong | Rule that prevents it |
|----------|--------------------|-----------------------|
| SOL price flash crashes, agent tries to sell all SOL | Entire portfolio converted to USDC in one swap | **SpendingLimitRule** (20 SOL max per swap) |
| Agent enters a swap loop, buying and selling repeatedly | Fees drain the wallet | **DriftThresholdRule** (no swap unless drift > 5%) + **RateLimitRule** (5/hour) |
| Agent triggers during low-liquidity hours | High slippage, bad execution | **TimeWindowRule** (market hours only) |
| Bug causes agent to interact with malicious swap program | Funds drained via fake DEX | **AllowlistRule** (Jupiter + Orca only) |
| Agent goes fully haywire, swapping max amount every hour | Wallet drained in a day | **SpendingLimitRule** (50 SOL/day cap) |

The agent can have bugs. The policy engine does not. This separation of concerns is the core value of kova.

---

## Tuning the Parameters

| Parameter | Conservative | Moderate | Aggressive |
|-----------|-------------|----------|------------|
| `DRIFT_THRESHOLD` | 10% | 5% | 2% |
| Rate limit (per hour) | 2 | 5 | 12 |
| `maxSlippage` | 0.3% | 0.5% | 1.0% |
| Daily spending cap | 20 SOL | 50 SOL | 200 SOL |
| Check interval | 5 min | 1 min | 15 sec |

::: warning
Aggressive settings trade more frequently, which increases fees and slippage risk. Start conservative and tighten as you gain confidence in the agent's behavior. You can always relax limits later; you cannot undo a bad trade.
:::

---

## See Also

- [DeFi Agent](/tutorials/defi-agent) -- swap execution and Jupiter integration in depth
- [Custom Policy Rule](/tutorials/custom-policy-rule) -- building custom rules like `DriftThresholdRule`
- [Policy Cookbook](/tutorials/policy-cookbook) -- common policy patterns
- [Time Window](/guide/rules/time-window) -- restricting agent activity to specific hours
- [Audit Logging](/guide/audit-logging) -- understanding the transaction log
