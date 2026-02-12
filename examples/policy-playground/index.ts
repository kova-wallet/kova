/* eslint-disable no-console */
/**
 * Policy Playground Example
 *
 * Interactive policy testing — NO blockchain connection needed.
 * Uses PolicyEngine directly with MemoryStore to demonstrate:
 *
 * 1. Three preset policies (conservative, liberal, business-hours)
 * 2. Evaluating various intents against each policy engine
 * 3. Rate limit enforcement via rapid-fire intents
 * 4. Spending accumulation across multiple transactions
 * 5. Policy serialization roundtrip (toJSON → fromJSON)
 * 6. Per-rule audit results from PolicyEvaluationResult
 *
 * Run: npx tsx examples/policy-playground/index.ts
 */

import {
  Policy,
  PolicyEngine,
  MemoryStore,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  TimeWindowRule,
} from "../../src/index.js";
import type { TransactionIntent, PolicyConfig } from "../../src/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SEPARATOR = "═".repeat(72);
const THIN_SEP = "─".repeat(72);

function heading(title: string): void {
  console.log(`\n${SEPARATOR}`);
  console.log(`  ${title}`);
  console.log(SEPARATOR);
}

function subheading(title: string): void {
  console.log(`\n${THIN_SEP}`);
  console.log(`  ${title}`);
  console.log(THIN_SEP);
}

/** Build a PolicyEngine from a Policy's JSON config and a fresh MemoryStore. */
function buildEngine(config: PolicyConfig): { engine: PolicyEngine; store: MemoryStore } {
  const store = new MemoryStore();
  const rules = [];

  if (config.spendingLimit) {
    rules.push(new SpendingLimitRule(config.spendingLimit));
  }
  if (config.allowAddresses || config.denyAddresses || config.allowPrograms || config.denyPrograms) {
    rules.push(
      new AllowlistRule({
        allowAddresses: config.allowAddresses,
        denyAddresses: config.denyAddresses,
        allowPrograms: config.allowPrograms,
        denyPrograms: config.denyPrograms,
      }),
    );
  }
  if (config.rateLimit) {
    rules.push(new RateLimitRule(config.rateLimit));
  }
  if (config.activeHours) {
    rules.push(new TimeWindowRule(config.activeHours));
  }

  const engine = new PolicyEngine(rules, store);
  return { engine, store };
}

// ── Preset Policies ─────────────────────────────────────────────────────────

const TREASURY = "7Vbmv1jt4vyuqBZcpYPpnVhrqVe5e6ZPb6JxDcffRHnT";

const conservativePolicy = Policy.create("conservative")
  .spendingLimit({
    perTransaction: { amount: "0.1", token: "SOL" },
    daily: { amount: "0.5", token: "SOL" },
  })
  .allowAddresses([TREASURY])
  .rateLimit({ maxTransactionsPerMinute: 2, maxTransactionsPerHour: 10 })
  .build();

const liberalPolicy = Policy.create("liberal")
  .spendingLimit({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
    weekly: { amount: "200", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 20 })
  .build();

const businessHoursPolicy = Policy.create("business-hours")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .activeHours({
    timezone: "America/New_York",
    windows: [
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    ],
  })
  .build();

// ── Test Intents ────────────────────────────────────────────────────────────

const smallTransfer: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: { to: TREASURY, amount: "0.05", token: "SOL" },
  metadata: { reason: "Small tip" },
};

const largeTransfer: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: { to: TREASURY, amount: "5.0", token: "SOL" },
  metadata: { reason: "Large payment" },
};

const swapIntent: TransactionIntent = {
  type: "swap",
  chain: "solana",
  params: { fromToken: "SOL", toToken: "USDC", amount: "0.5" },
  metadata: { reason: "Convert to stablecoins" },
};

const unknownRecipient: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: { to: "UnknownAddr111111111111111111111111111111111", amount: "0.05", token: "SOL" },
  metadata: { reason: "Transfer to unknown address" },
};

// ── Main ────────────────────────────────────────────────────────────────────

async function evaluateAndPrint(
  label: string,
  engine: PolicyEngine,
  intent: TransactionIntent,
): Promise<void> {
  const result = await engine.evaluate(intent);
  const decision = result.decision;
  const status =
    decision.decision === "ALLOW"
      ? "ALLOW"
      : decision.decision === "DENY"
        ? `DENY  (${decision.reason})`
        : `PENDING (request: ${decision.approvalRequestId})`;

  console.log(`  ${label.padEnd(30)} => ${status}`);

  // Print per-rule audit trail
  for (const audit of result.ruleAudits) {
    const ms = audit.evaluationTimeMs.toFixed(2);
    const reason = audit.reason ? ` — ${audit.reason}` : "";
    console.log(`    [${audit.result}] ${audit.rule} (${ms}ms)${reason}`);
  }
  console.log(`    Total evaluation: ${result.totalEvaluationTimeMs.toFixed(2)}ms`);
}

async function main() {
  // ── Section 1: Evaluate intents against each policy ───────────────────

  heading("1. Policy Evaluation — Conservative");
  {
    const { engine } = buildEngine(conservativePolicy.toJSON());
    await evaluateAndPrint("Small transfer (0.05 SOL)", engine, smallTransfer);
    await evaluateAndPrint("Large transfer (5.0 SOL)", engine, largeTransfer);
    await evaluateAndPrint("Swap (0.5 SOL)", engine, swapIntent);
    await evaluateAndPrint("Unknown recipient", engine, unknownRecipient);
  }

  heading("2. Policy Evaluation — Liberal");
  {
    const { engine } = buildEngine(liberalPolicy.toJSON());
    await evaluateAndPrint("Small transfer (0.05 SOL)", engine, smallTransfer);
    await evaluateAndPrint("Large transfer (5.0 SOL)", engine, largeTransfer);
    await evaluateAndPrint("Swap (0.5 SOL)", engine, swapIntent);
    await evaluateAndPrint("Unknown recipient", engine, unknownRecipient);
  }

  heading("3. Policy Evaluation — Business Hours");
  {
    const { engine } = buildEngine(businessHoursPolicy.toJSON());
    const now = new Date();
    const hour = now.getHours();
    const isBusinessHours = hour >= 9 && hour < 17 && now.getDay() >= 1 && now.getDay() <= 5;
    console.log(`  (Current time: ${now.toLocaleString()} — ${isBusinessHours ? "within" : "outside"} business hours)\n`);
    await evaluateAndPrint("Small transfer (0.05 SOL)", engine, smallTransfer);
    await evaluateAndPrint("Large transfer (5.0 SOL)", engine, largeTransfer);
  }

  // ── Section 2: Rate limit enforcement ─────────────────────────────────

  heading("4. Rate Limit Demo (conservative: max 2/min)");
  {
    const { engine } = buildEngine(conservativePolicy.toJSON());

    for (let i = 1; i <= 4; i++) {
      const intent: TransactionIntent = {
        type: "transfer",
        chain: "solana",
        params: { to: TREASURY, amount: "0.01", token: "SOL" },
        metadata: { reason: `Rapid-fire transfer #${i}` },
      };
      const result = await engine.evaluate(intent);
      const decision = result.decision;
      const status = decision.decision === "ALLOW" ? "ALLOW" : `DENY`;
      const reason = decision.decision === "DENY" ? ` — ${decision.reason}` : "";
      console.log(`  Transfer #${i}: ${status}${reason}`);
    }
  }

  // ── Section 3: Spending accumulation ──────────────────────────────────

  heading("5. Spending Accumulation (conservative: 0.5 SOL daily)");
  {
    const { engine } = buildEngine(conservativePolicy.toJSON());

    const amounts = ["0.09", "0.09", "0.09", "0.09", "0.09", "0.09"];
    let totalSpent = 0;

    for (let i = 0; i < amounts.length; i++) {
      const amount = amounts[i]!;
      const intent: TransactionIntent = {
        type: "transfer",
        chain: "solana",
        params: { to: TREASURY, amount, token: "SOL" },
        metadata: { reason: `Accumulation test #${i + 1}` },
      };
      const result = await engine.evaluate(intent);
      const decision = result.decision;

      if (decision.decision === "ALLOW") {
        totalSpent += parseFloat(amount);
        console.log(`  Transfer #${i + 1} (${amount} SOL): ALLOW  — total spent: ${totalSpent.toFixed(2)} SOL`);
      } else {
        console.log(`  Transfer #${i + 1} (${amount} SOL): DENY   — total spent: ${totalSpent.toFixed(2)} SOL`);
        if (decision.decision === "DENY") {
          console.log(`    Reason: ${decision.reason}`);
        }
      }
    }
  }

  // ── Section 4: Policy serialization roundtrip ─────────────────────────

  heading("6. Policy Serialization Roundtrip");
  {
    // Serialize to JSON
    const json = conservativePolicy.toJSON();
    console.log("  Original policy name:", conservativePolicy.getName());
    console.log("  Serialized JSON:");
    console.log(indent(JSON.stringify(json, null, 2), 4));

    // Deserialize back
    const restored = Policy.fromJSON(json);
    console.log("\n  Restored policy name:", restored.getName());

    // Verify configs match
    const restoredJson = restored.toJSON();
    const match = JSON.stringify(json) === JSON.stringify(restoredJson);
    console.log(`  Round-trip match: ${match ? "YES" : "NO (mismatch!)"}`);

    // Demonstrate Policy.extend()
    subheading("Policy Extension");
    const extended = Policy.extend(conservativePolicy, "conservative-v2")
      .spendingLimit({
        perTransaction: { amount: "0.2", token: "SOL" },
        daily: { amount: "1.0", token: "SOL" },
      })
      .build();

    console.log(`  Base policy: ${conservativePolicy.getName()}`);
    console.log(`  Extended policy: ${extended.getName()}`);
    console.log(`  Extended config:`);
    console.log(indent(JSON.stringify(extended.toJSON(), null, 2), 4));
  }

  // ── Section 5: Engine audit detail ────────────────────────────────────

  heading("7. Detailed Audit Trail (all rules evaluated)");
  {
    const { engine } = buildEngine(liberalPolicy.toJSON());

    const intent: TransactionIntent = {
      type: "transfer",
      chain: "solana",
      params: { to: TREASURY, amount: "3.0", token: "SOL" },
      metadata: { reason: "Detailed audit demo", agentId: "agent-007" },
    };

    const result = await engine.evaluate(intent);
    console.log(`  Final decision: ${result.decision.decision}`);
    console.log(`  Total evaluation time: ${result.totalEvaluationTimeMs.toFixed(2)}ms`);
    console.log(`  Rules evaluated: ${result.ruleAudits.length}`);
    console.log("");

    for (const audit of result.ruleAudits) {
      console.log(`  Rule: ${audit.rule}`);
      console.log(`    Result: ${audit.result}`);
      console.log(`    Time: ${audit.evaluationTimeMs.toFixed(3)}ms`);
      if (audit.reason) {
        console.log(`    Reason: ${audit.reason}`);
      }
      console.log("");
    }
  }

  console.log(`\n${SEPARATOR}`);
  console.log("  All demos complete!");
  console.log(SEPARATOR);
}

/** Indent every line of a multi-line string. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

main().catch(console.error);
