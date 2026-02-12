# Quick Start

This guide walks you through creating a policy-constrained wallet and executing your first transaction, from zero to a confirmed transfer.

## Complete Working Example

```typescript
import {
  AgentWallet,
  Policy,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
} from "kova";
import { Keypair } from "@solana/web3.js";

async function main() {
  // ── 1. Create a keypair and signer ──────────────────────────────────
  const keypair = Keypair.generate();
  const signer = new LocalSigner(keypair);
  console.log("Wallet address:", await signer.getAddress());

  // ── 2. Create a store for spending counters and audit logs ──────────
  const store = new MemoryStore();

  // ── 3. Create a chain adapter for Solana ────────────────────────────
  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",
    commitment: "confirmed",
  });

  // ── 4. Build a policy using the fluent builder ──────────────────────
  const policy = Policy.create("trading-agent")
    .spendingLimit({
      perTransaction: { amount: "1", token: "SOL" },
      daily: { amount: "5", token: "SOL" },
    })
    .allowAddresses([
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    ])
    .rateLimit({
      maxTransactionsPerMinute: 3,
      maxTransactionsPerHour: 20,
    })
    .build();

  // ── 5. Extract config and create individual rules ───────────────────
  const config = policy.toJSON();

  const rules = [
    new RateLimitRule(config.rateLimit!),
    new AllowlistRule({
      allowAddresses: config.allowAddresses,
    }),
    new SpendingLimitRule(config.spendingLimit!),
  ];

  // ── 6. Create the policy engine ─────────────────────────────────────
  const engine = new PolicyEngine(rules, store);

  // ── 7. Create the wallet ────────────────────────────────────────────
  const wallet = new AgentWallet({
    signer,
    chain,
    policy: engine,
    store,
  });

  // ── 8. Execute a transfer ───────────────────────────────────────────
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      amount: "0.5",
      token: "SOL",
    },
    metadata: {
      reason: "Payment for completed task",
      agentId: "trading-bot-01",
    },
  });

  // ── 9. Log the result ───────────────────────────────────────────────
  console.log("Transaction result:", {
    status: result.status,
    txId: result.txId,
    summary: result.summary,
    intentId: result.intentId,
  });

  // ── 10. Check the wallet's policy summary ───────────────────────────
  const policySummary = await wallet.getPolicy();
  console.log("Policy summary:", JSON.stringify(policySummary, null, 2));

  // ── 11. View transaction history ────────────────────────────────────
  const history = await wallet.getTransactionHistory(5);
  console.log("Recent transactions:", history.length);
}

main().catch(console.error);
```

## Expected Output

If the transfer succeeds (requires a funded devnet wallet):

```
Wallet address: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Transaction result: {
  status: 'confirmed',
  txId: '5UfgJ3vN...',
  summary: 'Sent 0.5 SOL to 9WzD...AWWM',
  intentId: 'a1b2c3d4-...'
}
```

If the wallet is unfunded (common on first devnet run):

```
Transaction result: {
  status: 'failed',
  txId: undefined,
  summary: 'Transaction failed: ...',
  intentId: 'a1b2c3d4-...'
}
```

::: tip
To fund your devnet wallet, use the [Solana Faucet](https://faucet.solana.com/) or run:
```bash
solana airdrop 2 <your-wallet-address> --url devnet
```
:::

## What Just Happened?

1. **Keypair** -- A new Solana keypair was generated in memory
2. **Signer** -- The `LocalSigner` wraps the keypair and can sign transactions
3. **Store** -- The `MemoryStore` tracks spending counters and audit logs in memory
4. **Chain adapter** -- The `SolanaAdapter` connects to Solana devnet via RPC
5. **Policy** -- The fluent builder created a policy config with spending limits, an allowlist, and rate limits
6. **Rules** -- Individual rule instances were created from the policy config
7. **Engine** -- The `PolicyEngine` evaluates rules sequentially (cheapest rules first)
8. **Wallet** -- The `AgentWallet` wires everything together
9. **Execute** -- The `execute()` pipeline validated the intent, checked all policy rules, built the transaction, signed it, and broadcast it to Solana
10. **Result** -- A structured `TransactionResult` with status, transaction ID, and summary

## Next Steps

- Read the [Concepts](/getting-started/concepts) page to understand the architecture
- Learn about the full [AgentWallet API](/guide/wallet)
- Explore all five [Intent Types](/guide/intents)
- Dive into the [Policy Engine](/guide/policy-engine) and individual [rules](/guide/rules/spending-limit)
