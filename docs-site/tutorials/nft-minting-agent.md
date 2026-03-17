# NFT Minting Agent

---

## What You'll Build

In this tutorial, you'll build an AI agent that autonomously mints NFTs on Solana, constrained by policy rules that prevent spam-minting and control costs. By the end, you'll have:

- A wallet configured with mint-specific policies (per-mint fee caps, collection allowlists, rate limits)
- A structured mint intent pipeline that validates metadata and collection addresses
- An agent loop that decides what to mint based on external triggers

Real-world use cases: an AI art agent that generates images and mints them as NFTs, a loyalty program agent that distributes reward NFTs to users, or a game agent that creates in-game assets.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |

You should have completed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial.

::: tip ADAPTER STATUS
The kova SDK defines the `mint` intent type with full validation and policy evaluation. The Solana adapter currently supports `transfer` and `swap` intents. Mint adapter support is on the roadmap. This tutorial sets up the complete policy and intent layer so everything is ready when adapter support lands -- and shows how to bridge the gap in the meantime using the custom intent type.
:::

---

## The Mint Intent

kova represents NFT minting as a structured intent:

```typescript
interface MintParams {
  /** Collection or program address */
  collection: string;
  /** Metadata URI (e.g., Arweave or IPFS link to the JSON metadata) */
  metadataUri: string;
  /** Recipient address (defaults to wallet address if omitted) */
  to?: string;
}
```

The agent says *what* it wants to mint (which collection, what metadata, who receives it). The SDK validates the intent, evaluates policy rules, and then delegates to the chain adapter to build and broadcast the transaction.

---

## Step 1: Design the Policy

NFT minting agents need specific guardrails:

| Risk | Policy Rule | Configuration |
|------|-------------|---------------|
| **Spam minting** | Rate limit | Max 10 mints per minute, 100 per hour |
| **Excessive fees** | Spending limit | Max 0.05 SOL per mint (covers rent + fees), 2 SOL daily |
| **Minting into unauthorized collections** | Allowlist | Only mint into pre-approved collection addresses |
| **Minting during off-hours** | Time window | Only mint Mon-Fri 9am-6pm ET |

```typescript
import {
  AgentWallet,
  LocalSigner,
  SqliteStore,
  SolanaAdapter,
  Policy,
} from "@kova-sdk/wallet";
import { Keypair } from "@solana/web3.js";

// ── Configuration ───────────────────────────────────────────────────────────

// The Metaplex collection addresses this agent is allowed to mint into.
// In production, load these from config or environment variables.
const ALLOWED_COLLECTIONS = [
  "CoLLecTion1111111111111111111111111111111111", // AI Art Collection
  "CoLLecTion2222222222222222222222222222222222", // Loyalty Rewards
];
```

---

## Step 2: Build the Policy Engine

```typescript
const store = new SqliteStore({ path: "./nft-agent.db" });

const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});

const keypair = Keypair.generate();
const signer = new LocalSigner(keypair, { network: "devnet" });

// Build the policy using the fluent builder.
// The Policy.create().build() pattern handles rule instantiation internally.
const policy = Policy.create("nft-minting-agent")
  .spendingLimit({
    // Each mint costs ~0.01-0.03 SOL in rent + fees.
    // 0.05 SOL per-transaction cap covers even compressed NFTs with extras.
    perTransaction: { amount: "0.05", token: "SOL" },
    // 2 SOL daily cap = ~40-200 mints per day depending on mint cost.
    daily: { amount: "2", token: "SOL" },
  })
  .rateLimit({
    // Prevent burst minting. 10/min is plenty for most use cases.
    // Note: RateLimitRule is stateful — it tracks transaction counts in the store.
    maxTransactionsPerMinute: 10,
    maxTransactionsPerHour: 100,
  })
  .allowAddresses(ALLOWED_COLLECTIONS)
  .activeHours({
    timezone: "America/New_York",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "18:00",
      },
    ],
  })
  .build();

const wallet = new AgentWallet({
  signer,
  chain,
  policy,
  store,
  dangerouslyDisableAuth: true,
});
```

::: details Why allowlist by collection address?
The `AllowlistRule` checks the target address of each intent. For mint intents, the target is the `collection` field. By adding collection addresses to `allowAddresses`, you restrict the agent to only mint into those specific collections. If the agent tries to mint into an unauthorized collection, the allowlist rule denies it before the transaction is even built.
:::

---

## Step 3: Structure the Mint Intent

Here is what a mint intent looks like:

```typescript
// Mint a new NFT into the AI Art Collection.
const mintResult = await wallet.execute({
  type: "mint",
  chain: "solana",
  params: {
    // The on-chain collection address this NFT belongs to.
    collection: "CoLLecTion1111111111111111111111111111111111",

    // URI pointing to the NFT's JSON metadata (hosted on Arweave, IPFS, etc.).
    // The metadata typically includes: name, description, image URL, attributes.
    metadataUri: "https://arweave.net/abc123-metadata-json",

    // Optional: send the minted NFT to a specific recipient.
    // Omit to mint to the agent's own wallet address.
    to: "RecipientAddr111111111111111111111",
  },
  metadata: {
    agentId: "nft-minting-agent",
    reason: "Minting loyalty reward for user #1042",
  },
});

console.log("Mint status:", mintResult.status);
console.log("Transaction ID:", mintResult.txId);
```

The SDK validates this intent before policy evaluation:
- `collection` must be a non-empty string and a valid Solana address
- `metadataUri` must be a non-empty string (max 2048 characters)
- `to` (if provided) must be a valid Solana address
- `chain` must match the configured chain adapter

---

## Step 4: Build the Agent Loop

A minting agent typically responds to external triggers -- a user request, a schedule, or an AI decision. Here is a simple loop:

```typescript
/** Represents a mint request from an external source */
interface MintRequest {
  /** Which collection to mint into */
  collection: string;
  /** Pre-uploaded metadata URI */
  metadataUri: string;
  /** Who should receive the NFT */
  recipient?: string;
  /** Why this mint was requested */
  reason: string;
}

/**
 * Process a mint request through the wallet.
 * The policy engine handles all safety checks automatically.
 */
async function processMintRequest(request: MintRequest) {
  console.log(`Processing mint request: ${request.reason}`);

  const result = await wallet.execute({
    type: "mint",
    chain: "solana",
    params: {
      collection: request.collection,
      metadataUri: request.metadataUri,
      ...(request.recipient ? { to: request.recipient } : {}),
    },
    metadata: {
      agentId: "nft-minting-agent",
      reason: request.reason,
    },
  });

  if (result.status === "confirmed") {
    console.log(`Minted successfully: ${result.txId}`);
  } else if (result.status === "denied") {
    console.log(`Mint denied by policy: ${result.error?.message}`);
    // The agent should respect the denial and not retry immediately.
    // Common reasons: rate limit hit, spending cap reached, collection not allowed.
  } else if (result.status === "failed") {
    console.log(`Mint failed on-chain: ${result.error?.message}`);
    // On-chain failure (e.g., collection is frozen, insufficient balance).
  }

  return result;
}

// ── Example: Batch minting loyalty rewards ──────────────────────────────────

async function mintLoyaltyRewards(recipients: string[]) {
  console.log(`Minting ${recipients.length} loyalty NFTs...`);

  const results = [];
  for (const recipient of recipients) {
    const result = await processMintRequest({
      collection: "CoLLecTion2222222222222222222222222222222222",
      metadataUri: "https://arweave.net/loyalty-reward-metadata",
      recipient,
      reason: `Loyalty reward distribution`,
    });
    results.push(result);

    // If rate-limited, wait before trying the next one.
    if (result.status === "denied" && result.error?.code === "RATE_LIMIT_EXCEEDED") {
      console.log("Rate limited -- waiting 15 seconds...");
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  const confirmed = results.filter((r) => r.status === "confirmed").length;
  const denied = results.filter((r) => r.status === "denied").length;
  console.log(`Done: ${confirmed} minted, ${denied} denied`);
}
```

---

## Step 5: Monitor Minting Activity

Use the audit log to track what the agent has minted:

```typescript
async function mintingReport() {
  const history = await wallet.getTransactionHistory(50);

  // Filter to only mint transactions.
  const mints = history.filter((tx) => tx.summary.includes("mint") || tx.summary.includes("Mint"));

  console.log(`\n═══ Minting Report ═══`);
  console.log(`Total mint attempts: ${mints.length}`);
  console.log(`Confirmed: ${mints.filter((m) => m.status === "confirmed").length}`);
  console.log(`Denied: ${mints.filter((m) => m.status === "denied").length}`);
  console.log(`Failed: ${mints.filter((m) => m.status === "failed").length}`);

  console.log(`\nRecent mints:`);
  for (const mint of mints.slice(0, 10)) {
    const time = new Date(mint.timestamp).toLocaleTimeString();
    console.log(`  [${time}] [${mint.status}] ${mint.summary}`);
  }
}
```

---

## Metadata Best Practices

The `metadataUri` in your mint intent should point to a JSON file following the Metaplex metadata standard:

```json
{
  "name": "AI Art #1042",
  "symbol": "AIART",
  "description": "Generated by the AI Art Agent",
  "image": "https://arweave.net/abc123-image.png",
  "attributes": [
    { "trait_type": "Style", "value": "Surrealist" },
    { "trait_type": "Generated By", "value": "Claude" },
    { "trait_type": "Generation Date", "value": "2025-06-15" }
  ],
  "properties": {
    "files": [
      { "uri": "https://arweave.net/abc123-image.png", "type": "image/png" }
    ],
    "category": "image"
  }
}
```

::: tip METADATA HOSTING
Upload metadata and images to a permanent storage solution **before** minting:
- **Arweave** — Permanent, pay-once storage. Best for high-value NFTs.
- **IPFS + Pinata/NFT.Storage** — Decentralized, requires pinning to stay available.
- **AWS S3 / Cloudflare R2** — Centralized but reliable. Fine for loyalty rewards and game assets.

The metadata URI must be accessible at mint time. If the URI returns a 404, the NFT will have broken metadata.
:::

---

## Policy Patterns for Different Minting Scenarios

| Scenario | Per-TX Limit | Daily Limit | Rate Limit | Allowlist |
|----------|-------------|-------------|------------|-----------|
| **AI Art (high-value)** | 0.1 SOL | 1 SOL | 5/hour | Single collection |
| **Loyalty rewards (batch)** | 0.02 SOL | 5 SOL | 50/min | Loyalty collection only |
| **Game assets (high-volume)** | 0.01 SOL | 10 SOL | 100/min | Game collection only |
| **1/1 drops (rare)** | 0.5 SOL | 1 SOL | 1/hour + approval gate | Curated collection |

For the 1/1 drops scenario, add an `ApprovalGateRule` to require human approval for each mint:

```typescript
import { ApprovalGateRule, CallbackApprovalChannel } from "@kova-sdk/wallet";

const approval = new CallbackApprovalChannel({
  name: "nft-approval",
  onApprovalRequest: async (request) => {
    await notifyApprover(request);
  },
  waitForDecision: async (request) => {
    return pollForResponse(request.id);
  },
});

// For 1/1 drops, add approval to the policy:
const dropPolicy = Policy.create("1-of-1-drops")
  .spendingLimit({
    perTransaction: { amount: "0.5", token: "SOL" },
    daily: { amount: "1", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerHour: 1 })
  .requireApproval({
    above: { amount: "0", token: "SOL" }, // every transaction requires approval
    timeout: 300_000,
  })
  .build();
```

---

## See Also

- [Your First Agent Wallet](/tutorials/first-wallet) -- basic wallet setup
- [Policy Cookbook](/tutorials/policy-cookbook) -- common policy configurations
- [Custom Policy Rule](/tutorials/custom-policy-rule) -- build rules for custom mint logic
- [Allowlist](/guide/rules/allowlist) -- restricting which collections the agent can interact with
- [Spending Limit](/guide/rules/spending-limit) -- controlling mint costs
