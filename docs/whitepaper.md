# kova: A Policy-Constrained Crypto Wallet SDK for Autonomous AI Agents

**Version 0.1 — Draft**
**February 2026**

---

## Table of Contents

1. [Abstract](#1-abstract)
2. [Introduction](#2-introduction)
3. [Background & Motivation](#3-background--motivation)
   - 3.1 The Rise of Autonomous AI Agents
   - 3.2 Agents Need Economic Agency
   - 3.3 The Containment Problem
4. [Related Work](#4-related-work)
   - 4.1 Traditional Crypto Wallets
   - 4.2 Account Abstraction (ERC-4337)
   - 4.3 MPC Wallets
   - 4.4 Existing Agent-Wallet Solutions
5. [Design Principles](#5-design-principles)
6. [Architecture Overview](#6-architecture-overview)
7. [Agent Interface Layer](#7-agent-interface-layer)
   - 7.1 Transaction Intents
   - 7.2 Tool Definitions
   - 7.3 Agent Adapters
   - 7.4 Multi-Step Transaction Support
8. [Policy Engine](#8-policy-engine)
   - 8.1 Policy Specification
   - 8.2 Spending Limits
   - 8.3 Address and Program Allowlists
   - 8.4 Human Approval Gates
   - 8.5 Time-Based Policies
   - 8.6 Policy Composition and Inheritance
   - 8.7 Policy Evaluation Flow
9. [Key Management & Signing](#9-key-management--signing)
   - 9.1 Signer Interface
   - 9.2 Local Keypair Signer
   - 9.3 MPC Signing
   - 9.4 TEE / Enclave Signing
   - 9.5 Signer Comparison Matrix
10. [State Management](#10-state-management)
    - 10.1 Store Interface
    - 10.2 What State Is Tracked
    - 10.3 Store Adapters
    - 10.4 State Consistency Guarantees
11. [Chain Abstraction](#11-chain-abstraction)
    - 11.1 Chain Adapter Interface
    - 11.2 Solana Adapter
    - 11.3 EVM Adapter (Planned)
    - 11.4 Cross-Chain Considerations
12. [Telegram Approval Bot](#12-telegram-approval-bot)
    - 12.1 Approval Flow
    - 12.2 Notification Design
    - 12.3 Security Considerations
    - 12.4 Extensibility to Other Channels
13. [Security Model & Threat Analysis](#13-security-model--threat-analysis)
    - 13.1 Threat Model
    - 13.2 Attack Vectors and Mitigations
    - 13.3 Principle of Least Privilege
    - 13.4 Audit and Logging
    - 13.5 Failure Modes
14. [Use Cases](#14-use-cases)
    - 14.1 Agent-to-Agent Payments
    - 14.2 Autonomous DeFi Operations
    - 14.3 NFT Minting and Management
    - 14.4 Service Payments and Micropayments
    - 14.5 DAO Treasury Management
15. [Comparison with Existing Solutions](#15-comparison-with-existing-solutions)
16. [Roadmap](#16-roadmap)
17. [Future Considerations](#17-future-considerations)
    - 17.1 Token Economics
    - 17.2 Decentralized Policy Management
    - 17.3 Agent Reputation Systems
    - 17.4 Onchain Policy Verification
18. [Conclusion](#18-conclusion)
19. [References](#19-references)

---

## 1. Abstract

As AI agents evolve from passive assistants to autonomous actors capable of executing multi-step tasks, they increasingly require the ability to transact with economic value. Existing crypto wallets are designed for human users — they rely on manual confirmation, browser extensions, and seed phrase custody — none of which are suitable for software agents that operate autonomously at machine speed.

**kova** is an open-source TypeScript SDK that provides AI agents with secure, policy-constrained access to onchain wallets. The SDK implements a three-layer architecture: an **Agent Interface Layer** that exposes wallet operations as tool calls compatible with any agent framework, a **Policy Engine** that enforces configurable containment rules (spending limits, address allowlists, human approval gates), and a **pluggable Key Management layer** that abstracts signing across local keypairs, MPC, and hardware enclaves.

The system is designed for Solana as its primary chain, with a chain-abstraction layer enabling future support for EVM chains and beyond. A Telegram-based human approval flow allows wallet owners to review and authorize high-value transactions in real time, ensuring that agents operate with economic agency while remaining under meaningful human oversight.

This paper describes the architecture, security model, threat analysis, and roadmap for kova, establishing a foundation for safe and composable agent-driven onchain economies.

---

## 2. Introduction

The year 2025 marked a turning point for AI agents. Models from Anthropic, OpenAI, and the open-source community demonstrated the ability to use tools, browse the web, write and execute code, and orchestrate complex multi-step workflows with minimal human intervention. By early 2026, autonomous agents are being deployed in production for customer support, code generation, research, data analysis, and an expanding range of business operations.

Yet these agents have a critical limitation: **they cannot spend money**.

An AI agent can draft an email but cannot pay for the API call to send it. It can find the best price for a service but cannot execute the purchase. It can identify a profitable DeFi position but cannot enter it. The moment an agent needs to interact with economic value, it hits a wall — existing wallets require a human to click "confirm."

This is not merely an inconvenience. It is a fundamental bottleneck in the evolution of autonomous systems. For agents to be truly autonomous, they need **economic agency** — the ability to allocate, spend, and receive value as part of their task execution.

But economic agency without constraints is dangerous. An agent with unrestricted access to a wallet could drain funds through a bug, a prompt injection attack, or an unexpected edge case in its reasoning. The challenge is not just giving agents wallets — it is giving them wallets they can use freely **within well-defined boundaries**.

**kova** addresses this challenge with three core ideas:

1. **Wallet-as-a-tool**: Wallet operations are exposed as structured tool calls that any LLM or agent framework can invoke, following the same patterns agents already use for web browsing, code execution, and file management.

2. **Policy-first containment**: Every transaction passes through a configurable policy engine before it reaches the signer. Policies define spending limits, allowlisted addresses, time-based restrictions, and human approval thresholds. The agent never has the ability to bypass the policy layer.

3. **Pluggable security**: The signing layer is abstracted behind an interface, allowing teams to start with a simple local keypair for development and progressively upgrade to MPC or hardware enclave signing in production — without changing any agent-facing code.

The result is an SDK that makes it as easy to give an agent a wallet as it is to give it a web browser — while ensuring that the agent's economic actions remain safe, auditable, and under human control.

---

## 3. Background & Motivation

### 3.1 The Rise of Autonomous AI Agents

The progression from language models to autonomous agents has followed a clear trajectory:

- **2023**: ChatGPT plugins and early tool use demonstrated that LLMs could interact with external systems. AutoGPT captured public imagination but struggled with reliability.
- **2024**: Anthropic's Claude introduced robust tool use. OpenAI shipped Assistants API with function calling. Agent frameworks like LangChain, CrewAI, and AutoGen matured. Agents began handling real production workloads.
- **2025**: Claude, GPT, and open-source models achieved high reliability in multi-step tool use. Enterprises deployed agents for code review, customer support, sales development, and research. The "agent-as-coworker" paradigm took hold.
- **2026 (current)**: Agents are becoming infrastructure. They operate in always-on loops, coordinate with each other, and are expected to handle tasks end-to-end — including tasks that involve money.

This progression reveals a pattern: each generation of agents gains access to more powerful tools. Agents gained the ability to read files, then write files, then execute code, then browse the web. The next frontier is clear: **agents need to transact**.

### 3.2 Agents Need Economic Agency

Consider the tasks that modern agents are asked to perform:

- **A research agent** finds the perfect dataset for a machine learning project. The dataset costs $50 on a marketplace. The agent cannot purchase it — a human must find the listing, enter payment details, and complete checkout.

- **A DevOps agent** detects a spike in traffic and determines that spinning up additional cloud compute would cost $12/hour. It cannot provision the resources — a human must approve the scaling.

- **A trading agent** identifies an arbitrage opportunity on a decentralized exchange. The opportunity exists for 30 seconds. By the time a human reviews and approves the transaction, it is gone.

- **A service agent** needs to pay another agent for a completed subtask. There is no agent-to-agent payment rail — the transaction must be mediated by human-operated payment systems.

In each case, the absence of economic agency creates friction, latency, and missed opportunities. Crypto wallets are the natural solution: they are programmable, permissionless, and operate at machine speed. But current wallets are not designed for agents.

### 3.3 The Containment Problem

Giving an agent unrestricted access to a wallet is analogous to giving an intern the company credit card with no spending limit. The intern may be competent and well-intentioned, but the downside risk is unbounded.

For AI agents, the risks are more specific:

- **Prompt injection**: A malicious input could instruct the agent to transfer all funds to an attacker's address. Without policy constraints, the agent would comply.
- **Reasoning errors**: LLMs can make confident but incorrect decisions. An agent might misinterpret a price, calculate a swap incorrectly, or misunderstand which contract to interact with.
- **Infinite loops**: An agent stuck in a retry loop could repeatedly submit failing transactions, each consuming gas fees, until the wallet is drained of its native token.
- **Scope creep**: An agent asked to "optimize the portfolio" might interpret this as permission to move all assets into a single high-risk position.

The containment problem is not hypothetical. It is the primary reason that agent-wallet integration has not yet been widely adopted despite the clear demand. **kova** exists to solve this problem by making containment a first-class architectural concern rather than an afterthought.

---

## 4. Related Work

### 4.1 Traditional Crypto Wallets

Traditional wallets (MetaMask, Phantom, Backpack) are designed around human interaction patterns. They present transactions for visual review, require manual confirmation via button clicks, and store keys in browser extensions or mobile apps. These wallets have no concept of policy-based access control, programmatic invocation, or autonomous operation. They are fundamentally unsuitable for agent use.

Some wallets expose JSON-RPC interfaces or SDKs (e.g., `@solana/web3.js`, `ethers.js`) that enable programmatic transaction construction and signing. However, these are low-level building blocks — they provide no policy enforcement, no spending limits, and no human approval workflows. Using them directly gives the agent full, unconstrained access to the private key.

### 4.2 Account Abstraction (ERC-4337)

Ethereum's ERC-4337 account abstraction standard enables smart contract wallets with programmable validation logic. A wallet can define custom rules for which transactions to approve, enable session keys with limited permissions, and support multi-sig or social recovery.

This is conceptually aligned with kova' goals. However, ERC-4337 has several limitations for our use case:

- **EVM-only**: Account abstraction is an Ethereum standard. Solana has no equivalent protocol.
- **Onchain policy enforcement**: All policy logic runs as smart contract code, which means gas costs for policy evaluation and limited expressiveness compared to offchain policy engines.
- **Complexity**: Implementing custom validation logic requires Solidity development, auditing, and deployment — a high barrier for teams that simply want to give their agent a constrained wallet.
- **Latency**: Policy evaluation happens during transaction validation, adding latency to the critical path.

kova takes a complementary approach: **offchain policy enforcement with onchain settlement**. This provides richer policy expressiveness, zero gas overhead for policy evaluation, and cross-chain compatibility.

### 4.3 MPC Wallets

Multi-Party Computation (MPC) wallets (Fireblocks, Fordefi, Lit Protocol) distribute key material across multiple parties so that no single party can sign a transaction alone. MPC is a custody technology — it answers "how are keys stored?" rather than "what transactions are allowed?"

MPC wallets are valuable as a **signing backend** for kova, and the SDK's pluggable signer architecture is designed to integrate with MPC providers. However, MPC alone does not solve the containment problem. An agent with access to an MPC signing share can still initiate any transaction — MPC ensures the key is not compromised, but does not constrain what the key is used for.

### 4.4 Existing Agent-Wallet Solutions

Several projects have begun addressing the agent-wallet intersection:

- **Crossmint** provides wallet APIs for agents but focuses on custodial wallets with limited policy configuration.
- **Coinbase AgentKit** offers agent-friendly wallet tooling for Base/EVM but is tightly coupled to the Coinbase ecosystem.
- **GOAT (Great Onchain Agent Toolkit)** provides a framework for onchain agent interactions but focuses more on the agent interface than on containment and security.
- **Solana Agent Kit** provides Solana-specific tooling for agents but lacks a comprehensive policy engine.

kova differentiates itself by treating **policy enforcement as the core value proposition**, not just an optional feature. The SDK is also designed to be chain-agnostic from day one, agent-framework-agnostic, and fully open-source with a pluggable architecture that avoids vendor lock-in.

---

## 5. Design Principles

The following principles guide every architectural decision in kova:

**1. Deny by default.** An agent can do nothing until a policy explicitly permits it. There are no default-open permissions. If a policy does not cover a transaction type, the transaction is rejected.

**2. Policy before signing.** Every transaction passes through the policy engine before it reaches the signer. There is no code path that bypasses policy evaluation. This is enforced architecturally, not by convention.

**3. Least privilege.** Agents should have access to the minimum wallet capabilities required for their task. A payment agent does not need DeFi permissions. A minting agent does not need transfer permissions.

**4. Progressive security.** Teams should be able to start with simple, low-overhead security (local keypair) and progressively upgrade (MPC, enclave) without rewriting their agent integration code. The SDK's interface remains stable across all security tiers.

**5. Agent-framework agnostic.** The SDK must work with Claude tool use, OpenAI function calling, LangChain, CrewAI, AutoGen, and any custom agent runtime. No agent framework should be privileged or required.

**6. Chain-agnostic core.** While Solana is the primary target, the core SDK (policy engine, state management, agent interface) must not contain Solana-specific logic. Chain-specific behavior is isolated in adapter modules.

**7. Auditability.** Every policy decision and every transaction must be logged with sufficient detail for post-hoc review. Wallet owners should be able to understand exactly what their agent did and why.

**8. Fail closed.** If the policy engine encounters an error, an ambiguous situation, or a state it cannot evaluate, the transaction is rejected. The system never fails into an open/permissive state.

---

## 6. Architecture Overview

kova is structured as a three-layer architecture with pluggable components at each layer:

```
┌──────────────────────────────────────────────────────────────┐
│                    AGENT INTERFACE LAYER                      │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  Claude   │  │   GPT    │  │LangChain │  │  Custom  │    │
│  │ Adapter   │  │ Adapter  │  │ Adapter  │  │ Adapter  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       └──────────────┴──────────────┴──────────────┘         │
│                          │                                   │
│              ┌───────────▼───────────┐                       │
│              │   Transaction Intent  │                       │
│              │   (structured action) │                       │
│              └───────────┬───────────┘                       │
├──────────────────────────┼───────────────────────────────────┤
│                    POLICY ENGINE                             │
│                          │                                   │
│              ┌───────────▼───────────┐                       │
│              │   Policy Evaluator    │                       │
│              │                       │                       │
│              │  ┌─────────────────┐  │                       │
│              │  │ Spending Limits │  │                       │
│              │  ├─────────────────┤  │                       │
│              │  │   Allowlists    │  │     ┌──────────────┐  │
│              │  ├─────────────────┤  │────▶│  Telegram     │  │
│              │  │ Approval Gates  │  │◀────│  Approval Bot │  │
│              │  ├─────────────────┤  │     └──────────────┘  │
│              │  │  Time Policies  │  │                       │
│              │  ├─────────────────┤  │     ┌──────────────┐  │
│              │  │ Custom Rules    │  │────▶│    Store      │  │
│              │  └─────────────────┘  │◀────│  (pluggable)  │  │
│              └───────────┬───────────┘     └──────────────┘  │
│                          │                                   │
│                  ALLOW / DENY / PENDING                      │
├──────────────────────────┼───────────────────────────────────┤
│               KEY MANAGEMENT & SIGNING                       │
│                          │                                   │
│              ┌───────────▼───────────┐                       │
│              │    Signer Interface   │                       │
│              │                       │                       │
│              │  ┌────┐ ┌────┐ ┌───┐ │                       │
│              │  │Local│ │MPC │ │TEE│ │                       │
│              │  └──┬──┘ └──┬─┘ └─┬─┘ │                       │
│              └─────┼───────┼─────┼───┘                       │
│                    └───────┼─────┘                            │
│                            │                                 │
│              ┌─────────────▼─────────────┐                   │
│              │     Chain Adapter          │                   │
│              │                           │                   │
│              │  ┌────────┐  ┌─────────┐  │                   │
│              │  │ Solana │  │  EVM    │  │                   │
│              │  │Adapter │  │ Adapter │  │                   │
│              │  └────────┘  └─────────┘  │                   │
│              └───────────────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

**Data flow for a transaction:**

1. The agent invokes a wallet tool (e.g., `send_sol`).
2. The Agent Interface Layer translates this into a **Transaction Intent** — a structured, chain-agnostic representation of what the agent wants to do.
3. The Policy Engine evaluates the intent against all configured policies. It may query the Store for current spending totals and may trigger a Telegram approval request.
4. If the policy evaluation returns `ALLOW`, the intent is passed to the Signer.
5. The Signer constructs and signs the chain-specific transaction.
6. The Chain Adapter broadcasts the transaction and returns a result.
7. The Store is updated with the transaction record and updated spending counters.
8. The result is returned to the agent.

If the policy evaluation returns `DENY`, the agent receives a structured error explaining which policy was violated and why. If it returns `PENDING` (awaiting human approval), the agent is informed that the transaction is awaiting review.

---

## 7. Agent Interface Layer

The Agent Interface Layer is the bridge between AI agent frameworks and the wallet SDK. Its job is to expose wallet capabilities in a format that agents can understand and invoke, regardless of the underlying agent framework.

### 7.1 Transaction Intents

Rather than exposing raw blockchain transaction construction to agents, kova uses **Transaction Intents** — high-level, structured descriptions of what the agent wants to accomplish.

```typescript
interface TransactionIntent {
  type: "transfer" | "swap" | "mint" | "stake" | "custom";
  chain: "solana" | "ethereum" | "base";
  params: TransferParams | SwapParams | MintParams | StakeParams | CustomParams;
  metadata?: {
    reason?: string;      // Why the agent wants to do this
    agentId?: string;     // Which agent initiated the request
    taskId?: string;      // What task this is part of
    urgency?: "low" | "normal" | "high";
  };
}

interface TransferParams {
  to: string;             // Recipient address
  amount: string;         // Human-readable amount (e.g., "1.5")
  token: string;          // Token symbol or mint address (e.g., "SOL", "USDC")
}

interface SwapParams {
  fromToken: string;      // Token to sell
  toToken: string;        // Token to buy
  amount: string;         // Amount of fromToken to sell
  maxSlippage?: number;   // Maximum slippage tolerance (e.g., 0.01 for 1%)
}
```

Intents serve several purposes:

- **Abstraction**: Agents do not need to understand transaction construction, program IDs, or encoding formats. They express *what* they want, not *how* to do it.
- **Policy evaluation**: Intents provide structured fields that policies can easily evaluate. A spending limit policy can inspect `amount` and `token`. An allowlist policy can inspect `to` or the contract being called.
- **Auditability**: Intents include metadata fields (`reason`, `agentId`, `taskId`) that create a rich audit trail.
- **Chain agnosticism**: The same intent structure works across chains. A transfer intent on Solana and Ethereum looks identical — the chain adapter handles the differences.

### 7.2 Tool Definitions

kova exposes its capabilities as **tool definitions** — structured JSON schemas that describe available operations, their parameters, and their return types. These schemas are compatible with the tool/function calling conventions of all major LLM providers.

```typescript
const tools = [
  {
    name: "wallet_get_balance",
    description: "Get the current balance of the wallet for a specific token",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token symbol (e.g., 'SOL', 'USDC') or mint address"
        }
      },
      required: ["token"]
    }
  },
  {
    name: "wallet_send",
    description: "Send tokens to an address. Subject to policy limits.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient wallet address" },
        amount: { type: "string", description: "Amount to send (e.g., '1.5')" },
        token: { type: "string", description: "Token symbol or mint address" },
        reason: { type: "string", description: "Why this transfer is needed" }
      },
      required: ["to", "amount", "token"]
    }
  },
  {
    name: "wallet_swap",
    description: "Swap one token for another via DEX. Subject to policy limits.",
    parameters: {
      type: "object",
      properties: {
        from_token: { type: "string", description: "Token to sell" },
        to_token: { type: "string", description: "Token to buy" },
        amount: { type: "string", description: "Amount of from_token to sell" },
        max_slippage: { type: "number", description: "Max slippage (e.g., 0.01 for 1%)" }
      },
      required: ["from_token", "to_token", "amount"]
    }
  },
  {
    name: "wallet_get_policy",
    description: "Get the current policy constraints so you know what you're allowed to do",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "wallet_get_transaction_history",
    description: "Get recent transaction history for audit purposes",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent transactions" }
      }
    }
  }
];
```

A critical design choice: the tool set includes `wallet_get_policy`, which allows the agent to **introspect its own constraints**. This enables agents to plan within their limits rather than repeatedly hitting policy rejections. An agent that knows its daily spending limit is 1 SOL can budget accordingly.

### 7.3 Agent Adapters

While tool definitions provide a universal schema, different agent frameworks have different conventions for registering and invoking tools. Agent adapters handle this translation.

```typescript
// Claude / Anthropic Tool Use
import { AgentWallet } from "kova";
import Anthropic from "@anthropic-ai/sdk";

const wallet = new AgentWallet({ /* config */ });
const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-sonnet-4-5-20250929",
  tools: wallet.toAnthropicTools(),  // Auto-converts to Anthropic format
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }]
});

// Handle tool calls
for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
    // Return result to Claude for next turn
  }
}
```

```typescript
// OpenAI Function Calling
const wallet = new AgentWallet({ /* config */ });

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools: wallet.toOpenAITools(),     // Auto-converts to OpenAI format
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }]
});
```

```typescript
// LangChain
import { AgentWallet } from "kova";
import { WalletToolkit } from "kova/langchain";

const wallet = new AgentWallet({ /* config */ });
const tools = new WalletToolkit(wallet).getTools();
// Use tools with any LangChain agent
```

```typescript
// Generic / Custom agents
const wallet = new AgentWallet({ /* config */ });

// Direct programmatic access
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "Alice...", amount: "0.1", token: "SOL" },
  metadata: { reason: "Payment for data processing" }
});
```

### 7.4 Multi-Step Transaction Support

Some operations require multiple onchain transactions. For example, swapping a token on Solana may require creating an associated token account first, or a DeFi operation may involve approving a token and then depositing it.

kova handles multi-step operations at the intent level. When an agent submits a swap intent, the chain adapter decomposes it into the necessary transactions and executes them in sequence. The agent sees a single operation; the complexity is handled internally.

```typescript
// Agent sees this:
const result = await wallet.execute({
  type: "swap",
  chain: "solana",
  params: { fromToken: "SOL", toToken: "USDC", amount: "1.0" }
});
// result.status: "confirmed"
// result.summary: "Swapped 1.0 SOL for 23.45 USDC"

// Under the hood, the chain adapter may have:
// 1. Created an ATA for USDC (if needed)
// 2. Fetched a quote from Jupiter
// 3. Executed the swap transaction
// 4. Confirmed the result
```

The policy engine evaluates the **intent** — the total value and destination of the operation — not each individual sub-transaction. This prevents policy circumvention through transaction splitting while keeping policy evaluation simple.

---

## 8. Policy Engine

The Policy Engine is the heart of kova. It is the component that transforms a regular wallet into a **contained** wallet — one that an agent can use freely within well-defined boundaries.

### 8.1 Policy Specification

Policies are defined using a **builder API** that provides type safety, IDE autocompletion, and validation at construction time. Policies can be serialized to JSON for storage, transmission, and inspection.

```typescript
import { Policy } from "kova";

const policy = Policy.create("trading-agent-policy")
  // Spending limits
  .spendingLimit({
    perTransaction: { amount: "0.5", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
    monthly: { amount: "50", token: "SOL" }
  })

  // Allowlisted programs (Solana program IDs the agent can interact with)
  .allowPrograms([
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter
    "11111111111111111111111111111111",                  // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",    // SPL Token
  ])

  // Allowlisted recipient addresses
  .allowAddresses([
    "ServiceProvider1...",
    "PaymentReceiver2...",
  ])

  // Human approval for high-value transactions
  .requireApproval({
    above: { amount: "1.0", token: "SOL" },
    channel: "telegram",
    timeout: 300_000, // 5 minutes to approve, then auto-reject
  })

  // Time-based restrictions
  .activeHours({
    timezone: "UTC",
    windows: [
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }
    ]
  })

  // Rate limiting
  .rateLimit({
    maxTransactionsPerMinute: 5,
    maxTransactionsPerHour: 30,
  })

  .build();

// Serialize for storage
const json = policy.toJSON();
fs.writeFileSync("policy.json", JSON.stringify(json, null, 2));

// Load from file
const loaded = Policy.fromJSON(JSON.parse(fs.readFileSync("policy.json", "utf-8")));
```

### 8.2 Spending Limits

Spending limits are the most fundamental containment mechanism. They bound the total economic exposure of the wallet to the agent.

Limits are defined in token-specific terms and tracked across multiple time windows:

| Window | Purpose | Example |
|--------|---------|---------|
| Per-transaction | Prevents any single large transfer | 0.5 SOL max per tx |
| Daily | Bounds 24-hour exposure | 5 SOL per day |
| Weekly | Medium-term budget control | 20 SOL per week |
| Monthly | Long-term budget control | 50 SOL per month |

**Value normalization**: When an agent sends USDC or another token, the policy engine normalizes the value to a common denomination (e.g., USD or SOL) using a price oracle to evaluate against spending limits. This prevents circumvention by sending value through different tokens.

```typescript
// Internal spending limit evaluation
async function evaluateSpendingLimit(
  intent: TransactionIntent,
  policy: SpendingLimitPolicy,
  store: Store
): Promise<PolicyDecision> {
  const valueInBaseCurrency = await normalizeValue(intent);

  // Check per-transaction limit
  if (valueInBaseCurrency > policy.perTransaction) {
    return {
      decision: "DENY",
      reason: `Transaction value ${valueInBaseCurrency} exceeds per-transaction limit of ${policy.perTransaction}`
    };
  }

  // Check daily limit
  const dailySpend = await store.getDailySpend(today());
  if (dailySpend + valueInBaseCurrency > policy.daily) {
    return {
      decision: "DENY",
      reason: `Transaction would exceed daily limit. Spent: ${dailySpend}, Limit: ${policy.daily}`
    };
  }

  return { decision: "ALLOW" };
}
```

### 8.3 Address and Program Allowlists

Allowlists restrict **who** and **what** the agent can interact with. There are two types:

**Address allowlists** define which wallet addresses the agent can send funds to. This is the simplest and most restrictive form of containment — the agent can only pay known recipients.

**Program allowlists** (Solana-specific) define which onchain programs the agent can invoke. This is more nuanced — it controls what *types* of operations the agent can perform.

```typescript
// Example: An agent that can only use Jupiter for swaps and the System Program for SOL transfers
.allowPrograms([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter Aggregator
  "11111111111111111111111111111111",                  // System Program (SOL transfers)
])
```

For EVM chains, the equivalent is **contract allowlists** — the set of smart contract addresses the agent is permitted to interact with, optionally scoped to specific function selectors.

**Deny lists** are also supported for cases where it is easier to block specific known-bad addresses than to enumerate all good ones.

### 8.4 Human Approval Gates

Human approval gates are the escape valve for transactions that exceed the agent's autonomous authority. When a transaction triggers an approval gate, the flow is:

1. The policy engine determines that approval is required.
2. A notification is sent to the configured channel (Telegram).
3. The transaction enters a `PENDING` state.
4. The human reviews the transaction details and approves or rejects it.
5. If approved, the transaction proceeds to signing. If rejected or timed out, the agent receives a denial.

```
Agent                  Policy Engine              Telegram Bot              Human
  │                        │                          │                      │
  │── send 2 SOL ─────────▶│                          │                      │
  │                        │── requires approval ─────▶│                      │
  │                        │                          │── notification ──────▶│
  │◀── PENDING ────────────│                          │                      │
  │                        │                          │      review...       │
  │   (agent can do        │                          │                      │
  │    other work)         │                          │◀──── APPROVE ────────│
  │                        │◀── approved ─────────────│                      │
  │◀── APPROVED ───────────│                          │                      │
  │                        │                          │                      │
```

Key design decisions:

- **Timeout**: Approval requests have a configurable timeout (default: 5 minutes). After timeout, the transaction is automatically rejected. This prevents indefinite blocking.
- **Context**: The approval notification includes the full transaction details plus the agent's stated reason, so the human can make an informed decision.
- **Non-blocking**: While awaiting approval, the agent is notified of the `PENDING` state and can continue other work. It can poll for the approval result or receive a callback.

### 8.5 Time-Based Policies

Time-based policies restrict when the agent can transact. Use cases include:

- **Business hours only**: An agent that manages corporate funds should only operate during business hours when team members are available to review alerts.
- **Trading windows**: A DeFi agent might be restricted to operating during high-liquidity hours to minimize slippage.
- **Cooldown periods**: After a high-value transaction, enforce a minimum wait time before the next transaction.

```typescript
.activeHours({
  timezone: "America/New_York",
  windows: [
    { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }
  ],
  outsideHoursPolicy: "deny", // or "require_approval"
})

.cooldown({
  afterTransactionAbove: { amount: "1.0", token: "SOL" },
  waitMinutes: 10,
})
```

### 8.6 Policy Composition and Inheritance

Real-world deployments often involve multiple agents with different roles and permissions. kova supports policy composition to handle this cleanly.

**Policy inheritance** allows defining a base policy that all agents share, with role-specific overrides:

```typescript
const basePolicy = Policy.create("base")
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .build();

const tradingAgentPolicy = Policy.extend(basePolicy, "trading-agent")
  .allowPrograms(["JUP6..."]) // Jupiter only
  .spendingLimit({ daily: { amount: "50", token: "SOL" } }) // Override: higher limit for trading
  .build();

const paymentAgentPolicy = Policy.extend(basePolicy, "payment-agent")
  .allowAddresses(["vendor1...", "vendor2..."]) // Only known vendors
  // Inherits base spending limit of 10 SOL/day
  .build();
```

**Policy intersection** ensures that when multiple policies apply, the most restrictive constraint wins. If a base policy sets a daily limit of 10 SOL and a role policy sets 50 SOL, the system uses the lower of the two unless the role policy is explicitly granted override authority.

### 8.7 Policy Evaluation Flow

The policy evaluation flow is deterministic and follows a strict order:

```
Intent received
     │
     ▼
┌─────────────┐     DENY
│ Rate Limit  │────────────▶ Return DENY + reason
│   Check     │
└──────┬──────┘
       │ OK
       ▼
┌─────────────┐     DENY
│ Time Window │────────────▶ Return DENY + reason
│   Check     │
└──────┬──────┘
       │ OK
       ▼
┌─────────────┐     DENY
│  Allowlist  │────────────▶ Return DENY + reason
│   Check     │
└──────┬──────┘
       │ OK
       ▼
┌─────────────┐     DENY
│  Spending   │────────────▶ Return DENY + reason
│ Limit Check │
└──────┬──────┘
       │ OK
       ▼
┌─────────────┐     PENDING
│  Approval   │────────────▶ Await human decision
│ Gate Check  │
└──────┬──────┘
       │ NOT REQUIRED
       ▼
┌─────────────┐     DENY
│   Custom    │────────────▶ Return DENY + reason
│   Rules     │
└──────┬──────┘
       │ OK
       ▼
   Return ALLOW
```

Policies are evaluated in order from cheapest to most expensive. Rate limits and time windows are pure computation (no I/O). Allowlists require comparing against a set. Spending limits require querying the store. Approval gates require human interaction. This ordering minimizes latency — expensive checks are only reached if all cheaper checks pass.

---

## 9. Key Management & Signing

The signing layer is responsible for constructing blockchain-specific transactions and signing them with the wallet's private key. It is intentionally separated from the policy engine so that custody technology can be upgraded independently.

### 9.1 Signer Interface

All signers implement a minimal interface:

```typescript
interface Signer {
  /** Get the public key / address of this signer */
  getAddress(): Promise<string>;

  /** Sign a transaction (already constructed by the chain adapter) */
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;

  /** Verify that the signer is operational and can sign */
  healthCheck(): Promise<boolean>;
}
```

The interface is deliberately minimal. Complex signing ceremonies (MPC rounds, enclave attestation) are implementation details — the consuming code only knows that it can request a signature.

### 9.2 Local Keypair Signer

The simplest signer holds a Solana `Keypair` in memory. It is instantaneous, requires no network calls, and is suitable for development, testing, and low-value production wallets.

```typescript
import { LocalSigner } from "kova/signers";
import { Keypair } from "@solana/web3.js";

const signer = new LocalSigner(Keypair.generate());
// or from a secret key
const signer = new LocalSigner(Keypair.fromSecretKey(secretKeyBytes));
```

**Security consideration**: The private key exists in process memory. If the agent process is compromised, the key is exposed. For this reason, local signers should only be used for development or wallets with minimal funds. The policy engine provides the containment layer — even if the key is compromised, spending limits bound the exposure.

### 9.3 MPC Signing

MPC (Multi-Party Computation) signing distributes the private key into shares held by separate parties. No single party has access to the complete key. To sign a transaction, the parties engage in a cryptographic protocol that produces a valid signature without reconstructing the key.

```typescript
import { MPCSigner } from "kova/signers";

const signer = new MPCSigner({
  provider: "lit-protocol",  // or "fireblocks", "fordefi"
  keyId: "agent-wallet-001",
  threshold: 2,              // 2-of-3 signatures required
  participants: [
    { id: "agent", share: agentShare },
    { id: "policy-server", share: policyShare },
    { id: "recovery", share: recoveryShare },
  ]
});
```

In a typical kova MPC deployment:
- **Share 1**: Held by the agent runtime (or policy server).
- **Share 2**: Held by a separate approval service.
- **Share 3**: Held offline for key recovery.

This means even if the agent process is fully compromised (including the policy engine), the attacker cannot sign transactions without also compromising the second share holder.

### 9.4 TEE / Enclave Signing

Trusted Execution Environments (TEEs) such as Intel SGX, ARM TrustZone, or AWS Nitro Enclaves provide hardware-isolated execution environments. A TEE-based signer keeps the private key inside the enclave, where it is inaccessible to the host operating system.

```typescript
import { EnclaveSigner } from "kova/signers";

const signer = new EnclaveSigner({
  provider: "aws-nitro",
  enclaveId: "enclave-abc-123",
  attestationEndpoint: "https://attestation.example.com",
});
```

TEE signing provides strong guarantees: even if the server is compromised at the OS level, the key remains protected inside the enclave. However, TEEs add operational complexity (enclave deployment, attestation verification) and are not available in all hosting environments.

### 9.5 Signer Comparison Matrix

| Property | Local Keypair | MPC (2-of-3) | TEE / Enclave |
|----------|:------------:|:------------:|:-------------:|
| Signing latency | <1ms | 100-500ms | 10-50ms |
| Key compromise if server hacked | Yes | No (need 2 shares) | No (hardware isolated) |
| Setup complexity | Trivial | Moderate | High |
| Operational overhead | None | Key ceremony, share management | Enclave deployment, attestation |
| Cost | Free | Provider fees | Infrastructure cost |
| Best for | Dev, low-value | Production, high-value | Production, regulatory |

**Recommendation**: Start with **Local Keypair** during development. Move to **MPC** for production deployments where the wallet holds meaningful value. Consider **TEE** for regulated environments or when compliance requires hardware key protection.

---

## 10. State Management

The policy engine requires state to enforce cumulative policies (daily spending limits, rate limits, cooldowns). The state management layer provides this capability through a pluggable store interface.

### 10.1 Store Interface

```typescript
interface Store {
  /** Get a value by key */
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL (in seconds) */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Atomically increment a numeric value. Returns the new value. */
  increment(key: string, amount: number): Promise<number>;

  /** Append an entry to a list (for transaction logs) */
  append(key: string, value: string): Promise<void>;

  /** Get the most recent N entries from a list */
  getRecent(key: string, count: number): Promise<string[]>;
}
```

The interface is intentionally minimal — five operations. This makes it trivial to implement adapters for any storage backend.

### 10.2 What State Is Tracked

The store tracks exactly three categories of data:

**1. Spending counters** — Atomic counters tracking total spend within each time window. Keys are structured as `spend:{token}:{window}:{period}` (e.g., `spend:SOL:daily:2026-02-11`). TTLs are set to the window duration so counters auto-expire.

**2. Rate limit counters** — Sliding window counters for transaction rate limiting. Keys are structured as `rate:{window}:{period}`.

**3. Transaction log** — An append-only log of all transaction intents, policy decisions, and results. Used for auditing and for the `wallet_get_transaction_history` tool. Each entry includes timestamp, intent, policy decision, and blockchain transaction result.

The store does *not* track balances, token holdings, or blockchain state. These are always queried from the chain in real-time to ensure accuracy.

### 10.3 Store Adapters

```typescript
// In-memory store — for development and testing
import { MemoryStore } from "kova/stores";
const store = new MemoryStore();

// SQLite store — for single-process production deployments
import { SqliteStore } from "kova/stores";
const store = new SqliteStore({ path: "./kova.db" });

// Redis store — for multi-process or distributed deployments
import { RedisStore } from "kova/stores";
const store = new RedisStore({ url: "redis://localhost:6379" });
```

### 10.4 State Consistency Guarantees

Spending limit enforcement requires atomic read-check-increment operations. The store interface uses `increment` (atomic by design in Redis and SQLite) to prevent race conditions where two concurrent transactions could both pass a spending check before either updates the counter.

```typescript
// Atomic spending limit check
async function checkAndUpdateSpend(
  store: Store,
  token: string,
  amount: number,
  limit: number,
  window: string
): Promise<{ allowed: boolean; currentSpend: number }> {
  const key = `spend:${token}:daily:${window}`;

  // Atomic increment — returns the new total
  const newTotal = await store.increment(key, amount);

  if (newTotal > limit) {
    // Undo the increment — we're over limit
    await store.increment(key, -amount);
    return { allowed: false, currentSpend: newTotal - amount };
  }

  return { allowed: true, currentSpend: newTotal };
}
```

For the MemoryStore, this atomicity is trivially guaranteed (single-threaded JavaScript). For Redis, `INCRBY` is atomic. For SQLite, transactions with `IMMEDIATE` locking provide the same guarantee.

---

## 11. Chain Abstraction

kova is designed to support multiple blockchains through a chain adapter pattern. The core SDK knows nothing about specific chains — all chain-specific logic is encapsulated in adapters.

### 11.1 Chain Adapter Interface

```typescript
interface ChainAdapter {
  chain: string;  // "solana", "ethereum", "base", etc.

  /** Get the wallet's balance for a specific token */
  getBalance(address: string, token: string): Promise<TokenBalance>;

  /** Get the current USD value of a token amount (for policy evaluation) */
  getValueInUSD(token: string, amount: string): Promise<number>;

  /** Build an unsigned transaction from a TransactionIntent */
  buildTransaction(intent: TransactionIntent): Promise<UnsignedTransaction>;

  /** Broadcast a signed transaction to the network */
  broadcast(signedTx: SignedTransaction): Promise<TransactionResult>;

  /** Get the status of a previously submitted transaction */
  getTransactionStatus(txId: string): Promise<TransactionStatus>;

  /** Validate an address for this chain */
  isValidAddress(address: string): boolean;
}
```

### 11.2 Solana Adapter

The Solana adapter is the primary implementation and supports:

- **SOL transfers** via the System Program.
- **SPL Token transfers** via the Token Program, including automatic Associated Token Account (ATA) creation.
- **Token swaps** via Jupiter Aggregator, the dominant DEX aggregator on Solana.
- **NFT operations** via Metaplex protocols (minting, transferring, and managing both standard and compressed NFTs).
- **Staking** via native Solana staking.
- **Arbitrary program interactions** for advanced use cases, subject to program allowlist policies.

```typescript
import { SolanaAdapter } from "kova/chains/solana";

const solana = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "confirmed",
  jupiterApiUrl: "https://quote-api.jup.ag/v6",
});
```

The Solana adapter handles Solana-specific concerns like:
- Transaction size limits (1232 bytes) and instruction packing.
- Priority fees and compute unit estimation.
- Transaction confirmation strategies (polling vs. WebSocket subscription).
- Versioned transactions (legacy vs. v0).
- Lookup tables for address-heavy transactions.

### 11.3 EVM Adapter (Planned)

The EVM adapter is planned for a future release and will support Ethereum, Base, Arbitrum, Polygon, and other EVM-compatible chains. Key considerations:

- **Gas estimation**: EVM gas costs are more variable than Solana's fixed fee model. The adapter will include gas estimation and configurable gas strategies.
- **ERC-20 approvals**: Many EVM DeFi interactions require a separate approval transaction before the main operation.
- **Account abstraction**: On EVM chains, the adapter can optionally use ERC-4337 smart contract wallets, enabling onchain policy enforcement as a complementary layer.
- **Chain-specific DEX integration**: Uniswap on Ethereum/Base, SushiSwap, 1inch aggregator.

### 11.4 Cross-Chain Considerations

Cross-chain operations (e.g., bridging tokens from Solana to Ethereum) are out of scope for the initial release but are a natural extension. The chain adapter pattern supports this through:

- **Bridge adapters**: A new adapter type that orchestrates cross-chain transfers via bridge protocols (Wormhole, LayerZero).
- **Cross-chain policy**: Policies that can express cross-chain constraints (e.g., "total daily spend across all chains must not exceed $500").
- **Unified balance view**: Aggregating balances across chains for the agent's awareness.

---

## 12. Telegram Approval Bot

The Telegram Approval Bot is the human-in-the-loop component of kova. It enables wallet owners to review and approve high-value transactions from their phone in real time.

### 12.1 Approval Flow

When a transaction triggers an approval gate:

1. The policy engine creates an `ApprovalRequest` with a unique ID, the transaction details, the agent's stated reason, and the current wallet state (balance, daily spend so far).

2. The Telegram bot sends a rich notification to the configured chat:

```
🔔 Transaction Approval Request

Agent: trading-agent-01
Action: Send 2.5 SOL to 7xKp...3mF9
Reason: "Payment for premium market data feed"

Amount: 2.5 SOL (~$375 USD)
Recipient: 7xKp...3mF9 (not in address book)
Daily spend so far: 3.2 / 5.0 SOL

⏱ Expires in 5:00

[✅ Approve]  [❌ Reject]
```

3. The human taps Approve or Reject.

4. The bot sends the decision back to the policy engine via a callback.

5. If no decision is made within the timeout, the request is automatically rejected.

### 12.2 Notification Design

Notifications are designed for quick, informed decision-making:

- **Transaction summary**: What the agent wants to do, in plain language.
- **Value context**: The amount in both crypto and USD terms.
- **Budget context**: How much of the daily/monthly budget has been used.
- **Risk indicators**: Flags for unknown addresses, unusually large amounts, or unusual timing.
- **Agent reasoning**: The agent's stated reason for the transaction (from intent metadata).
- **One-tap action**: Approve or Reject buttons for fast response.

### 12.3 Security Considerations

The Telegram bot is a critical security component — if compromised, an attacker could approve arbitrary transactions. Mitigations:

- **Authenticated chat**: The bot only accepts commands from a pre-configured Telegram user ID or group. Messages from other users are ignored.
- **Confirmation for large amounts**: For transactions above a second threshold, the bot requires typing a confirmation code (not just tapping a button).
- **Rate limiting**: The bot limits the number of approval requests it will process per time window, preventing approval fatigue attacks.
- **Audit logging**: All approval decisions are logged with the Telegram user ID, timestamp, and message ID for forensic review.
- **No sensitive data in messages**: Transaction details shown in Telegram do not include private keys, mnemonics, or other secrets.

### 12.4 Extensibility to Other Channels

While Telegram is the primary approval channel, the approval system is designed behind an interface that can support additional channels:

```typescript
interface ApprovalChannel {
  name: string;
  sendRequest(request: ApprovalRequest): Promise<void>;
  onDecision(callback: (requestId: string, decision: ApprovalDecision) => void): void;
}
```

Future channels may include:
- **Slack bot**: For team-based approval workflows.
- **Web dashboard**: For organizations that prefer a browser-based interface.
- **Email**: For low-urgency approval with longer timeouts.
- **Mobile push notification**: Via a dedicated kova companion app.

---

## 13. Security Model & Threat Analysis

Security is not a feature of kova — it is the reason kova exists. This section formally describes the threat model, known attack vectors, and the mitigations the SDK provides.

### 13.1 Threat Model

**Assets under protection:**
- Cryptocurrency funds held in the wallet.
- Private key material.
- Policy configuration (modification of policies is equivalent to gaining access to funds).
- Transaction integrity (ensuring executed transactions match intended transactions).

**Trust boundaries:**

```
┌─────────────────────────────────────────────────┐
│                  TRUSTED ZONE                    │
│                                                  │
│  Policy Engine  ←→  Store  ←→  Signer           │
│                                                  │
│  (code authored and deployed by wallet owner)    │
├─────────────────────────────────────────────────┤
│               SEMI-TRUSTED ZONE                  │
│                                                  │
│  AI Agent (may be manipulated via inputs)        │
│  Telegram Bot (depends on Telegram's security)   │
│                                                  │
├─────────────────────────────────────────────────┤
│              UNTRUSTED ZONE                      │
│                                                  │
│  External inputs to the agent                    │
│  Blockchain mempool / validators                 │
│  Price oracles                                   │
│  Third-party RPC providers                       │
└─────────────────────────────────────────────────┘
```

The critical insight: **the AI agent itself is in the semi-trusted zone**. It is not fully trusted because its behavior can be influenced by prompt injection, hallucination, or reasoning errors. The policy engine exists precisely because the agent cannot be fully trusted.

### 13.2 Attack Vectors and Mitigations

#### 13.2.1 Prompt Injection

**Attack**: A malicious input instructs the agent to transfer all funds to an attacker's address.

**Mitigation**: Multiple layers.
- **Spending limits** cap the maximum damage regardless of the agent's behavior.
- **Address allowlists** prevent transfers to unknown addresses.
- **Approval gates** require human confirmation for high-value transactions.
- The policy engine operates **outside the agent's influence** — the agent cannot modify, disable, or bypass policies.

Even if a prompt injection fully controls the agent's tool calls, the policy engine will still enforce all constraints. The attacker can only cause the agent to attempt transactions that violate policy — they cannot cause the policy to be overridden.

#### 13.2.2 Transaction Manipulation

**Attack**: The agent constructs a transaction that appears benign but actually performs a different operation (e.g., a "transfer 0.01 SOL" intent that actually executes a "transfer all SOL" transaction).

**Mitigation**: The agent does **not** construct transactions. The agent submits Transaction Intents, and the chain adapter constructs the actual transaction. The chain adapter is trusted code (authored by the wallet owner or the SDK), not generated by the agent. The agent has no mechanism to inject arbitrary instructions into the transaction.

#### 13.2.3 Key Extraction

**Attack**: The agent attempts to read the private key from memory or exfiltrate it through a side channel.

**Mitigation**:
- With **local signers**: The key is in the same process, so this is technically possible. Mitigation relies on the agent's sandboxing — tool-using LLMs typically cannot execute arbitrary code. For agents that can execute code (AutoGPT-style), use MPC or enclave signers.
- With **MPC signers**: The agent holds at most one key share, which is useless without the other shares.
- With **enclave signers**: The key is hardware-isolated and cannot be read by any software, including the agent process.

#### 13.2.4 Policy Bypass

**Attack**: The agent attempts to modify policy configuration or interact directly with the signer, bypassing the policy engine.

**Mitigation**: Architectural. The `AgentWallet` class is the only interface exposed to the agent. It does not expose the signer, the store, or the policy configuration. The agent can call `wallet.execute(intent)` and `wallet.getBalance()` — nothing else. There is no code path from the agent interface to the signer that does not pass through the policy engine.

```typescript
class AgentWallet {
  private readonly signer: Signer;        // Not exposed
  private readonly policy: PolicyEngine;   // Not exposed
  private readonly store: Store;           // Not exposed

  // Only public methods — these are all the agent can access
  public async execute(intent: TransactionIntent): Promise<TransactionResult> { ... }
  public async getBalance(token: string): Promise<TokenBalance> { ... }
  public async getPolicy(): Promise<PolicySummary> { ... }  // Read-only summary
  public async getTransactionHistory(limit: number): Promise<TransactionRecord[]> { ... }
}
```

#### 13.2.5 Denial of Service (Self-Inflicted)

**Attack**: The agent enters a loop, submitting thousands of transaction requests that all get rejected, consuming rate limit budget and flooding logs.

**Mitigation**:
- **Rate limiting** at the policy engine level caps the number of intents evaluated per time window.
- **Circuit breaker**: After N consecutive policy rejections, the wallet enters a cooldown period and rejects all requests for a configurable duration. This prevents runaway agents from consuming resources.

#### 13.2.6 Oracle Manipulation

**Attack**: The price oracle used for value normalization (spending limit evaluation) is manipulated, causing the policy engine to underestimate the value of a transaction.

**Mitigation**:
- Use multiple oracle sources and take the median.
- Set spending limits in native token terms (SOL, not USD) when possible, as these do not depend on oracles.
- Apply a safety margin to oracle prices (e.g., use the higher of the oracle price and the 24h TWAP).
- For high-value transactions, the human approval gate provides a final check that does not depend on oracle accuracy.

#### 13.2.7 Telegram Bot Compromise

**Attack**: An attacker gains access to the Telegram bot token and auto-approves transactions.

**Mitigation**:
- Telegram bot token is stored securely (environment variable or secret manager), not in code.
- Bot validates that approval messages come from the configured user ID.
- For amounts above a second threshold, the bot requires a typed confirmation code (not just a button tap).
- Approval rate limiting prevents rapid bulk approvals.
- Bot token can be rotated without affecting wallet keys or policy configuration.

### 13.3 Principle of Least Privilege

kova implements least privilege at every level:

- **Agent level**: Each agent gets only the wallet capabilities its policy permits. A payment agent has no swap tools. A trading agent has no mint tools.
- **Policy level**: Deny by default. Capabilities must be explicitly granted.
- **Signer level**: The signer only signs transactions that have passed policy evaluation. It has no independent decision-making.
- **Store level**: The store holds counters and logs, never keys. Compromising the store cannot lead to fund loss.

### 13.4 Audit and Logging

Every policy evaluation produces a structured log entry:

```typescript
interface AuditEntry {
  timestamp: string;
  intentId: string;
  agentId: string;
  intent: TransactionIntent;
  policyDecisions: {
    rule: string;           // Which policy rule was evaluated
    result: "ALLOW" | "DENY" | "PENDING";
    reason: string;         // Human-readable explanation
    evaluationTimeMs: number;
  }[];
  finalDecision: "ALLOW" | "DENY" | "PENDING";
  transactionResult?: {
    txId: string;
    status: "confirmed" | "failed";
    blockTime: number;
  };
}
```

Audit logs can be exported to external systems (e.g., a SIEM, a log aggregator, or a simple file) for monitoring and alerting.

### 13.5 Failure Modes

kova is designed to **fail closed** — any unexpected condition results in transaction rejection.

| Failure | Behavior |
|---------|----------|
| Store unavailable | DENY — cannot verify spending limits |
| Oracle unavailable | DENY — cannot normalize values for limit check |
| Signer unavailable | DENY — cannot sign |
| Telegram bot unavailable | DENY — cannot obtain required approval |
| RPC node unavailable | DENY — cannot broadcast transaction |
| Unknown intent type | DENY — no policy rules match |
| Policy evaluation error | DENY — fail closed |

---

## 14. Use Cases

### 14.1 Agent-to-Agent Payments

As multi-agent systems become common, agents need to pay each other for completed subtasks. Consider a research pipeline:

1. **Orchestrator agent** receives a user request: "Analyze the top 10 Solana DeFi protocols by TVL."
2. Orchestrator delegates to **data agent**: "Fetch TVL data for these protocols." Data agent charges 0.001 SOL for the query.
3. Orchestrator delegates to **analysis agent**: "Compare these protocols on risk-adjusted returns." Analysis agent charges 0.005 SOL.
4. Orchestrator compiles results and responds to the user.

With kova, each agent has its own constrained wallet. The orchestrator's policy allows payments to known agent addresses up to 0.01 SOL per transaction. Payments are instant (Solana finality ~400ms), trustless, and automatically logged.

### 14.2 Autonomous DeFi Operations

A DeFi agent manages a yield-optimizing strategy:

- The agent monitors yields across Solana DeFi protocols (Marinade, Jito, Raydium, Orca).
- When a better yield opportunity is found, the agent swaps and rebalances.
- Policy constraints: daily rebalancing budget of 10 SOL, only allowlisted protocols, max 1% slippage on swaps, human approval for positions above 5 SOL.

The agent operates autonomously within these bounds, capturing yield opportunities that would be missed with manual management, while the policy engine ensures it cannot take excessive risk.

### 14.3 NFT Minting and Management

A creative agent manages an NFT collection:

- The agent generates artwork, uploads metadata to Arweave, and mints NFTs on demand.
- When a buyer requests a piece, the agent mints and transfers it.
- Policy constraints: maximum 50 mints per day, only interact with the collection's Metaplex program, minting cost budget of 2 SOL/day.

### 14.4 Service Payments and Micropayments

An agent acts as a service consumer, paying for APIs, compute, and storage:

- The agent needs market data from a premium API (0.001 SOL per query).
- It needs GPU compute for inference (0.01 SOL per minute).
- It needs to store results on Arweave (0.005 SOL per upload).

Policy constraints: per-transaction limit of 0.05 SOL, daily budget of 1 SOL, only allowlisted service provider addresses. The agent can freely consume services within budget without human intervention.

### 14.5 DAO Treasury Management

An agent assists with DAO treasury operations:

- The agent monitors the DAO's treasury and executes approved spending proposals.
- When a governance proposal passes, the agent executes the payment.
- Policy constraints: only execute transactions matching approved proposal IDs, require 2-of-3 Telegram approval from DAO multisig members.

This use case extends the approval bot to support multi-party approval — a natural extension of the single-approver model.

---

## 15. Comparison with Existing Solutions

| Feature | kova | Coinbase AgentKit | GOAT | Solana Agent Kit | Raw @solana/web3.js |
|---------|:------------:|:-----------------:|:----:|:----------------:|:------------------:|
| Policy engine | Full | Basic | None | None | None |
| Spending limits | Per-tx, daily, monthly | None | None | None | None |
| Human approval | Telegram (extensible) | None | None | None | None |
| Address allowlists | Yes | No | No | No | No |
| Agent-framework agnostic | Yes | OpenAI-focused | LangChain-focused | Varies | N/A |
| Primary chain | Solana | Base/EVM | Multi-chain | Solana | Solana |
| Multi-chain support | Planned | EVM only | Yes | No | No |
| Pluggable signers | Local, MPC, TEE | Custodial | Varies | Local only | Local only |
| Audit logging | Built-in | None | None | None | None |
| Open source | Yes | Yes | Yes | Yes | Yes |
| Deny by default | Yes | No | No | No | No |
| Fail closed | Yes | No | No | No | No |

kova is the only solution that treats **containment** as a first-class architectural concern. Other solutions focus on making it easy for agents to transact — kova focuses on making it **safe** for agents to transact.

---

## 16. Roadmap

### Phase 1: Foundation (Q1 2026)
- Core SDK with Agent Interface Layer, Policy Engine, and State Management.
- Local Keypair signer.
- Solana chain adapter (transfers, swaps via Jupiter, SPL token operations).
- MemoryStore and SqliteStore.
- Telegram Approval Bot.
- Claude and OpenAI agent adapters.
- Comprehensive test suite and documentation.
- npm package release.

### Phase 2: Production Hardening (Q2 2026)
- MPC signer integration (Lit Protocol, Fireblocks).
- RedisStore for distributed deployments.
- Policy builder UI (web dashboard for non-developers).
- Advanced policy rules: custom JavaScript predicates, conditional logic.
- LangChain and CrewAI adapters.
- Security audit by independent firm.
- Gas optimization and transaction batching.

### Phase 3: Multi-Chain (Q3 2026)
- EVM chain adapter (Ethereum, Base, Arbitrum).
- Cross-chain policy evaluation (unified spending limits across chains).
- Slack approval channel.
- Agent reputation scoring (track agent reliability over time).
- Plugin marketplace for community-contributed chain adapters and policy rules.

### Phase 4: Decentralization (Q4 2026)
- Onchain policy verification (publish policy commitments onchain for transparency).
- Decentralized policy management (policy changes require multi-sig or governance).
- Token economics exploration (see Section 17.1).
- Agent-to-agent payment protocol standardization.
- TEE signer integration (AWS Nitro, Intel SGX).

---

## 17. Future Considerations

### 17.1 Token Economics

While kova launches as a pure open-source SDK with no token, a token model may be explored in future phases. Potential token utilities:

- **Policy staking**: Wallet owners stake tokens to signal commitment to their stated policies, creating accountability. If an agent wallet violates its published policy (detectable onchain), the stake is slashed.
- **Reputation bonds**: Agents stake tokens as a reputation bond. Reliable agents build reputation over time; agents that misbehave lose their stake.
- **Fee market**: A decentralized marketplace where agents pay for policy verification services, oracle access, or premium signer backends.
- **Governance**: Token holders govern the protocol's development, including which chain adapters and policy rules are included in the standard distribution.

Any token design would follow a utility-first approach — the token must provide clear functional value beyond speculation. A detailed tokenomics paper would be published separately if this direction is pursued.

### 17.2 Decentralized Policy Management

In the initial design, policies are set by the wallet owner and enforced by the SDK running on their infrastructure. This is centralized — the wallet owner has full control over policy configuration.

Future versions may explore decentralized policy management:

- **Onchain policy commitments**: The wallet's policy is published onchain as a hash. Anyone can verify that the agent is operating under the claimed policy.
- **Multi-sig policy changes**: Policy modifications require approval from multiple parties (e.g., the agent developer, the wallet funder, and an independent auditor).
- **DAO-governed policies**: For DAO treasury agents, policy changes go through governance proposals.

### 17.3 Agent Reputation Systems

As more agents transact onchain, a reputation system becomes valuable:

- **Transaction history scoring**: Agents that consistently operate within policy build a track record.
- **Cross-wallet reputation**: An agent's reputation follows it across wallet instances.
- **Reputation-based limits**: Agents with strong reputations may be granted higher spending limits over time.

This creates a natural progression: new agents start with tight constraints and earn more autonomy through demonstrated reliability.

### 17.4 Onchain Policy Verification

A longer-term vision involves moving policy enforcement partially or fully onchain:

- **Solana**: A custom program that enforces spending limits and allowlists at the protocol level.
- **EVM**: ERC-4337 validation logic that mirrors the offchain policy engine.

Onchain enforcement provides stronger guarantees (tamper-proof) but at the cost of gas overhead and reduced policy expressiveness. A hybrid approach — offchain policy for rich rules, onchain policy for critical invariants — may offer the best trade-off.

---

## 18. Conclusion

AI agents are rapidly gaining the capability to perform complex, multi-step tasks autonomously. Economic agency — the ability to transact with real value — is the next frontier. But giving agents unrestricted access to wallets is dangerous. The industry needs a middle ground: agents that can transact freely within well-defined boundaries.

**kova** provides this middle ground through a three-layer architecture that separates concerns cleanly:

1. An **Agent Interface Layer** that makes wallet operations accessible to any AI agent framework.
2. A **Policy Engine** that enforces configurable containment rules, ensuring agents operate within bounds set by their human operators.
3. A **pluggable Key Management layer** that allows progressive security upgrades without disrupting agent integration.

The SDK is designed around a core philosophy: **deny by default, fail closed, and make containment a first-class concern**. Every transaction passes through the policy engine. There is no bypass. The agent is treated as a semi-trusted actor whose economic actions are bounded by policies it cannot modify.

Starting with Solana and expanding to EVM chains, kova aims to become the standard infrastructure layer for agent-driven onchain economies — enabling a future where AI agents participate in economic networks safely, transparently, and under meaningful human oversight.

The code is open source. The architecture is modular. The mission is clear: **give agents wallets they can use, with guardrails they can't remove.**

---

## 19. References

1. Ethereum Foundation. "ERC-4337: Account Abstraction Using Alt Mempool." Ethereum Improvement Proposals, 2023.
2. Solana Foundation. "Solana Program Library (SPL)." https://spl.solana.com
3. Jupiter Aggregator. "Jupiter V6 API Documentation." https://docs.jup.ag
4. Metaplex Foundation. "Metaplex Developer Documentation." https://developers.metaplex.com
5. Anthropic. "Claude Tool Use Documentation." https://docs.anthropic.com/claude/docs/tool-use
6. OpenAI. "Function Calling in the Chat Completions API." OpenAI API Documentation, 2024.
7. Lindell, Y. "Secure Multiparty Computation (MPC)." Communications of the ACM, 2021.
8. Intel Corporation. "Intel Software Guard Extensions (SGX) Developer Guide." 2023.
9. LangChain. "Tools and Toolkits." LangChain Documentation, 2024.
10. Lit Protocol. "Programmable Key Pairs (PKPs)." https://developer.litprotocol.com
11. Fireblocks. "MPC Wallet Infrastructure." https://www.fireblocks.com
12. AWS. "AWS Nitro Enclaves." https://aws.amazon.com/ec2/nitro/nitro-enclaves
13. OWASP Foundation. "OWASP Top 10." https://owasp.org/Top10

---

*kova is open-source software. This whitepaper is a living document and will be updated as the project evolves.*

*For contributions, discussions, and issue reports, visit the project repository.*
