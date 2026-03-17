# Transaction Intents

::: info What you'll learn
- How intents let agents describe _what_ they want without knowing blockchain details
- The five intent types: transfer, swap, mint, stake, and custom
- How to attach metadata for audit logging and approval workflows
- How idempotency prevents duplicate transactions on retries
- How to use TypeScript type guards for safe parameter access
:::

## Overview

A Transaction Intent is **like a purchase order -- it describes what you want to buy, not how the payment is processed**. When you tell the SDK "send 2.5 SOL to this address," you are creating an intent. You do not need to know how to construct low-level blockchain instructions, manage nonces, or format binary data. The SDK translates your high-level request into the exact chain-specific operations needed to make it happen.

If you have used declarative APIs before (like writing SQL instead of manual B-tree operations, or describing a Kubernetes deployment instead of SSH-ing into servers), you already understand the pattern. Intents are the declarative layer that sits between your AI agent and the blockchain.

Transaction intents are high-level, declarative descriptions of what an agent wants to accomplish. Agents express _what_ they want, not _how_ to do it. The SDK handles all chain-specific details.

### When would I use this?

- **Any time your agent needs to do something on-chain.** Every call to `wallet.execute()` takes a `TransactionIntent` as its argument.
- **You want your agent code to be chain-agnostic.** The same intent structure works whether the underlying chain is Solana today or Ethereum tomorrow.
- **You want auditability.** Intents carry metadata (who requested it, why, and for what task) that gets stored in the audit log.

## TransactionIntent

```typescript
// Import TypeScript types used for defining transaction intents.
// TransactionIntent: the main interface describing what the agent wants to do.
// IntentType: the union type of supported operations ("transfer", "swap", "mint", "stake", "custom").
// ChainId: the union type of supported blockchains ("solana", "ethereum", "base").
// IntentMetadata: optional context attached to intents for auditing and approval flows.
import type { TransactionIntent, IntentType, ChainId, IntentMetadata } from "@kova/wallet";
```

```typescript
// The TransactionIntent interface is the core data structure that agents use
// to express what they want to accomplish. The SDK translates this high-level
// description into chain-specific transactions.
interface TransactionIntent {
  /** Unique identifier for this intent (auto-generated if not provided) */
  id?: string;
  /** The type of operation */
  type: IntentType;
  /** Target chain */
  chain: ChainId;
  /** Operation-specific parameters */
  params: IntentParams;
  /** Optional metadata for audit and context */
  metadata?: IntentMetadata;
  /** Timestamp when the intent was created */
  createdAt?: number;
}
```

::: tip Think of it like a REST API request
A `TransactionIntent` is structured like a well-designed API call: it has a **verb** (`type` -- what operation to perform), a **target** (`chain` -- which network), **parameters** (`params` -- the details), and **headers** (`metadata` -- context for logging and approvals). You describe what you want; the SDK figures out the how.
:::

### IntentType

The five supported operations. Each one maps to a different kind of blockchain action.

```typescript
// Defines the five supported transaction operations.
// "transfer": send tokens from the wallet to a recipient address.
// "swap": exchange one token for another via a DEX (e.g., Jupiter on Solana).
// "mint": create/mint an NFT from a collection.
// "stake": delegate tokens to a validator or staking pool.
// "custom": execute an arbitrary on-chain program instruction (advanced).
type IntentType = "transfer" | "swap" | "mint" | "stake" | "custom";
```

| Type | Plain-English Meaning | Real-World Analogy |
|------|----------------------|-------------------|
| `transfer` | Send tokens to someone | Wiring money to another bank account |
| `swap` | Exchange one token for another | Exchanging USD for EUR at a currency exchange |
| `mint` | Create a new NFT (digital collectible) | Printing a limited-edition certificate |
| `stake` | Lock tokens to earn rewards | Putting money in a fixed deposit that earns interest |
| `custom` | Run any arbitrary blockchain instruction | Sending a raw HTTP request instead of using an SDK method |

### ChainId

```typescript
// Defines the supported blockchain identifiers.
// "solana": fully implemented with the SolanaAdapter chain adapter.
// "ethereum" and "base": reserved for future chain adapter implementations.
// "system": used internally for system-level intents.
// Using an unsupported chain ID will cause validation to fail at execution time.
type ChainId = "solana" | "ethereum" | "base" | "system";
```

::: tip
Currently, only `"solana"` has a full chain adapter implementation. `"ethereum"` and `"base"` are defined as valid chain IDs for forward compatibility.
:::

## Intent Types

### Transfer

Send tokens from the wallet to a recipient address. This is the most commonly used intent type -- it covers paying for services, distributing rewards, or moving funds between accounts.

```typescript
// Parameters specific to a "transfer" intent.
// The SDK uses these fields to build the appropriate on-chain transfer instruction
// (e.g., a Solana SystemProgram.transfer for SOL, or an SPL Token transfer for USDC).
interface TransferParams {
  /** Recipient wallet address */
  to: string;
  /** Human-readable amount (e.g., "1.5") */
  amount: string;
  /** Token symbol (e.g., "SOL", "USDC") or mint address */
  token: string;
}
```

::: tip Key terms
- **Wallet address**: A unique identifier for an account on the blockchain, like a bank account number. On Solana, it looks like a long string of letters and numbers (e.g., `9WzDXwBb...`).
- **SOL**: The native currency of the Solana blockchain.
- **SPL tokens**: Additional currencies built on top of Solana (like USDC, a stablecoin pegged to the US dollar). "SPL" stands for Solana Program Library -- think of them as apps that create custom currencies on Solana.
- **Mint address**: The unique identifier for a specific SPL token type. You can use the human-readable symbol (e.g., `"USDC"`) or the full mint address.
:::

Example:

```typescript
// Create a transfer intent to send 2.5 SOL to a specific Solana address.
// The intent is declarative — it describes WHAT to do, not HOW.
// The SolanaAdapter will convert this into the correct Solana transaction instructions.
const transferIntent: TransactionIntent = {
  type: "transfer",   // Specifies this is a token transfer operation
  chain: "solana",    // Target the Solana blockchain
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Recipient's base58-encoded Solana address
    amount: "2.5",    // Send 2.5 SOL (human-readable; the SDK converts to lamports: 2,500,000,000)
    token: "SOL",     // Native Solana token; use "USDC" or a mint address for SPL tokens
  },
  metadata: {
    reason: "Payment for data labeling task", // Explains why the agent is making this payment (recorded in audit log)
    agentId: "labeling-agent",                // Identifies which AI agent initiated the request
  },
};
```

::: warning Amount is always a string
Notice that `amount` is `"2.5"` (a string), not `2.5` (a number). This is intentional -- floating-point numbers can introduce rounding errors in financial calculations. The SDK parses the string precisely and converts it to the blockchain's smallest unit internally (lamports for SOL, where 1 SOL = 1,000,000,000 lamports).
:::

### Swap

Exchange one token for another via a DEX (Jupiter on Solana). A **DEX** (Decentralized Exchange) is like a currency exchange counter, but automated and running on the blockchain. **Jupiter** is a popular DEX aggregator on Solana that finds the best exchange rate across multiple exchanges.

```typescript
// Parameters specific to a "swap" intent.
// On Solana, swaps are routed through the Jupiter aggregator, which finds the best
// price across multiple DEXs (Raydium, Orca, etc.).
interface SwapParams {
  /** Token to sell */
  fromToken: string;
  /** Token to buy */
  toToken: string;
  /** Amount of fromToken to sell (human-readable) */
  amount: string;
  /** Maximum slippage tolerance (e.g., 0.01 for 1%). Defaults to 0.5% */
  maxSlippage?: number;
}
```

::: tip What is slippage?
**Slippage** is the difference between the price you expect and the price you actually get. Prices on decentralized exchanges can change between the moment you request a quote and the moment your transaction executes. Setting `maxSlippage: 0.01` means "I accept up to a 1% worse price than quoted." If the price moves more than that, the transaction fails instead of executing at a bad rate. This is similar to a limit order in stock trading.
:::

Example:

```typescript
// Create a swap intent to exchange 1.0 SOL for USDC on Solana.
// The SolanaAdapter uses the Jupiter aggregator API to find the best swap route
// and build the transaction instructions.
const swapIntent: TransactionIntent = {
  type: "swap",       // Specifies this is a token swap operation
  chain: "solana",    // Target the Solana blockchain (Jupiter DEX aggregator)
  params: {
    fromToken: "SOL",      // The token being sold (input token)
    toToken: "USDC",       // The token being bought (output token)
    amount: "1.0",         // Sell exactly 1.0 SOL
    maxSlippage: 0.01,     // Allow up to 1% slippage (price difference between quote and execution)
  },
  metadata: {
    reason: "Converting SOL to stablecoin for payment", // Audit trail explanation
  },
};
```

### Mint

Mint an NFT from a collection. **NFTs** (Non-Fungible Tokens) are unique digital items on the blockchain -- think of them as digital certificates of authenticity or collectible trading cards. **Minting** is the act of creating a new one.

```typescript
// Parameters specific to a "mint" intent.
// Used to mint new NFTs from an existing on-chain collection.
interface MintParams {
  /** Collection or program address */
  collection: string;
  /** Metadata URI */
  metadataUri: string;
  /** Recipient address (defaults to wallet address) */
  to?: string;
}
```

Example:

```typescript
// Create a mint intent to mint an NFT from the DRiP collection on Solana.
// The collection address identifies which NFT program/candy machine to interact with,
// and the metadataUri points to the JSON metadata (name, image, attributes) stored on Arweave.
const mintIntent: TransactionIntent = {
  type: "mint",        // Specifies this is an NFT minting operation
  chain: "solana",     // Target the Solana blockchain
  params: {
    collection: "DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4x", // On-chain collection/program address
    metadataUri: "https://arweave.net/abc123/metadata.json",       // URI to the NFT's metadata JSON (stored on Arweave for permanence)
  },
};
```

::: warning
Mint operations on Solana are not yet fully implemented in the `SolanaAdapter`. The intent type exists for forward compatibility. Attempting to execute a mint intent will result in an "unsupported intent" error.
:::

### Stake

Stake tokens with a validator or staking pool. **Staking** is like putting money in a savings account that helps keep the bank running -- you lock up tokens to help secure the blockchain network, and in return you earn rewards (interest). A **validator** is a server that processes transactions on the network.

```typescript
// Parameters specific to a "stake" intent.
// Staking locks tokens with a validator to help secure the network
// and earn staking rewards.
interface StakeParams {
  /** Amount to stake (human-readable) */
  amount: string;
  /** Token to stake */
  token: string;
  /** Validator or pool address */
  validator?: string;
}
```

Example:

```typescript
// Create a stake intent to stake 10 SOL with a specific Solana validator.
// Staking on Solana involves creating a stake account and delegating it to the validator.
// The validator address identifies which validator node will receive the delegation.
const stakeIntent: TransactionIntent = {
  type: "stake",       // Specifies this is a staking operation
  chain: "solana",     // Target the Solana blockchain
  params: {
    amount: "10",      // Stake 10 SOL (human-readable)
    token: "SOL",      // The token to stake (currently only SOL is relevant on Solana)
    validator: "7Sys3UQhQbPz3azGKEHFBHL2uSrqxiSfNH7J4CYGHEeJ", // Validator's vote account address
  },
};
```

::: warning
Stake operations on Solana are not yet fully implemented in the `SolanaAdapter`. The intent type exists for forward compatibility.
:::

### Custom

Execute an arbitrary program instruction (advanced use case). This is the escape hatch for when the built-in intent types do not cover what you need. Think of it as sending a raw HTTP request instead of using a high-level SDK method -- you have full control, but you need to know exactly what you are doing.

A **program** on Solana is equivalent to a smart contract on Ethereum -- it is code deployed on the blockchain that anyone can interact with.

```typescript
// Parameters specific to a "custom" intent.
// This is the escape hatch for advanced users who need to interact with
// any on-chain program beyond the built-in transfer/swap/mint/stake operations.
// The raw instruction data and account list are passed directly to the chain adapter.
interface CustomParams {
  /** Program or contract address to interact with */
  programId: string;
  /** Instruction data (base64 encoded) */
  data: string;
  /** Accounts involved in the instruction */
  accounts: Array<{
    address: string;     // The Solana account address
    isSigner: boolean;   // Whether this account must sign the transaction
    isWritable: boolean; // Whether the instruction will modify this account's data or balance
  }>;
}
```

Example:

```typescript
// Create a custom intent to execute a raw instruction on the SPL Token Program.
// This bypasses the SDK's high-level transaction building and sends raw instruction data.
// Use this when you need to call a program that isn't natively supported by the SDK.
const customIntent: TransactionIntent = {
  type: "custom",      // Specifies this is an arbitrary program instruction
  chain: "solana",     // Target the Solana blockchain
  params: {
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // The SPL Token Program address on Solana
    data: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",               // Base64-encoded instruction data (program-specific binary format)
    accounts: [
      // Each account entry specifies an account the instruction interacts with.
      // The Solana runtime uses isSigner and isWritable for security checks.
      { address: "9WzDXwBb...", isSigner: false, isWritable: true },  // Token account (writable because its balance changes)
      { address: "HN7cABqL...", isSigner: false, isWritable: false }, // Mint account (read-only for this instruction)
    ],
  },
};
```

::: danger
Custom intents bypass the SDK's high-level transaction building. The `data` and `accounts` are passed directly to the chain adapter. Ensure the instruction data is correct -- malformed instructions can lead to lost funds.
:::

::: tip When to use custom intents
Most developers will never need custom intents. Use them only when you need to interact with a Solana program that is not covered by the built-in `transfer`, `swap`, `mint`, or `stake` intent types. If you are building a standard payment or trading agent, stick with the built-in types.
:::

## Intent Metadata

Optional metadata provides context for audit logging and approval requests. Think of metadata as the memo field on a bank wire transfer -- it does not affect the transfer itself, but it tells anyone reviewing the transaction why it happened.

```typescript
// IntentMetadata lets agents attach context to each transaction.
// This metadata is NOT sent on-chain — it is stored in the local audit log
// and included in approval requests sent via the configured ApprovalChannel.
interface IntentMetadata {
  /** Why the agent wants to perform this action */
  reason?: string;
  /** Identifier for the agent that initiated the request */
  agentId?: string;
  /** Identifier for the task this is part of */
  taskId?: string;
}
```

Metadata is stored in the audit log and included in approval requests sent to humans. The `reason` field is particularly valuable -- it tells the human approver _why_ the agent wants to make the transaction.

::: tip Best practice: Always include a reason
When a human approver receives a notification asking "Approve 5 SOL transfer?", the `reason` field is what helps them decide. "Purchasing training data from vendor" is far more useful than no explanation at all. Make your agents explain themselves.
:::

```typescript
// Example of a transfer intent with full metadata.
// The metadata helps operators and approvers understand the context of each transaction.
const intent: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: "5",
    token: "SOL",
  },
  metadata: {
    reason: "Purchasing training data from vendor",  // Human-readable justification shown in approval request notifications
    agentId: "ml-pipeline-agent",                    // Identifies the specific agent (useful when multiple agents share a wallet)
    taskId: "task-2024-001",                         // Links this transaction to an external task/job ID for traceability
  },
};
```

## Intent ID and Idempotency

Every intent is assigned a unique ID. If you provide an `id` field, it is used for **idempotency** (preventing duplicate transactions). If omitted, a UUID is generated automatically.

**Idempotency** is a critical concept for payment systems: it means that submitting the same request twice produces the same result, without executing the action twice. If you have used Stripe's idempotency keys, this is the same idea.

**Idempotency behavior:**

- When an intent is executed, the result is cached in the store with the intent ID as the key and a 24-hour TTL (time-to-live).
- If the same intent ID is submitted again within 24 hours, the cached result is returned immediately without re-executing the pipeline.
- Only `confirmed` and `failed` results are cached. `denied` and `pending` results are NOT cached because the condition may change (e.g., rate limit expires, approval arrives).

```typescript
// First call: executes the full 10-step pipeline (validate, policy check, build, sign, broadcast, etc.)
const result1 = await wallet.execute({
  id: "payment-001",   // Explicit intent ID — used as the idempotency key in the store
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "1", token: "SOL" },
});

// Second call with the SAME intent ID: the SDK finds the cached result in the store
// and returns it immediately WITHOUT re-executing the pipeline or sending another transaction.
// This prevents duplicate on-chain transactions caused by retries or agent bugs.
const result2 = await wallet.execute({
  id: "payment-001",   // Same ID as above — triggers idempotency cache hit
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "1", token: "SOL" },
});

// result1 and result2 are identical — only one on-chain transaction was sent
```

::: tip
Use deterministic intent IDs (e.g., derived from task IDs) to prevent duplicate transactions when retrying after network errors. For example: `id: \`payment-\${taskId}\`` ensures that even if your agent retries, the same task never triggers two payments.
:::

## Intent ID Validation

If provided, the intent ID must be:

- A `string` type
- Between 1 and 128 characters long

Invalid intent IDs result in a `VALIDATION_FAILED` error.

## Type Guard Functions

The SDK exports type guard functions for narrowing intent types in TypeScript. These are runtime functions that check the `type` field of an intent and narrow the TypeScript type of `params`, giving you safe access to operation-specific fields without manual type casting.

If you are not using TypeScript, you can skip this section -- but the same `type` field check works in plain JavaScript with `if (intent.type === "transfer")`.

```typescript
// Import type guard functions from the SDK.
// These are runtime functions that check the intent's `type` field
// and narrow the TypeScript type of `intent.params` accordingly.
import {
  isTransferIntent,
  isSwapIntent,
  isMintIntent,
  isStakeIntent,
  isCustomIntent,
} from "@kova/wallet";

// A helper function that produces a human-readable description of any intent.
// Each type guard narrows the `params` type, giving full type safety inside the branch.
function describeIntent(intent: TransactionIntent): string {
  if (isTransferIntent(intent)) {
    // After this check, TypeScript knows intent.params is TransferParams,
    // so accessing .amount, .token, and .to is type-safe.
    return `Transfer ${intent.params.amount} ${intent.params.token} to ${intent.params.to}`;
  }
  if (isSwapIntent(intent)) {
    // TypeScript knows intent.params is SwapParams here,
    // so .fromToken, .toToken, and .amount are available.
    return `Swap ${intent.params.amount} ${intent.params.fromToken} for ${intent.params.toToken}`;
  }
  if (isMintIntent(intent)) {
    // TypeScript knows intent.params is MintParams here.
    return `Mint NFT from ${intent.params.collection}`;
  }
  if (isStakeIntent(intent)) {
    // TypeScript knows intent.params is StakeParams here.
    return `Stake ${intent.params.amount} ${intent.params.token}`;
  }
  if (isCustomIntent(intent)) {
    // TypeScript knows intent.params is CustomParams here.
    return `Custom instruction to ${intent.params.programId}`;
  }
  // Fallback for unknown or future intent types.
  return `Unknown intent type: ${intent.type}`;
}
```

Each type guard narrows the `params` field to the corresponding parameter interface, giving you full type safety when accessing operation-specific fields.

## Common Mistakes

**1. Passing `amount` as a number instead of a string.**
`amount: 1.5` will cause a validation error. Always use a string: `amount: "1.5"`. This avoids floating-point precision issues that can cause incorrect payment amounts.

**2. Forgetting to include `metadata.reason`.**
While metadata is optional, omitting the `reason` makes it much harder for human approvers to make informed decisions and for you to debug issues in the audit log later. Always provide a reason.

**3. Using the wrong chain ID.**
If you set `chain: "ethereum"` but your wallet is configured with a `SolanaAdapter`, the transaction will fail at validation. The chain ID in the intent must match the chain adapter configured in your `AgentWallet`.

## Quick Reference

### Intent Types

| Type | Params Interface | Status | Description |
|------|-----------------|--------|-------------|
| `transfer` | `TransferParams` | Fully supported | Send tokens to a recipient address |
| `swap` | `SwapParams` | Fully supported | Exchange one token for another via DEX |
| `mint` | `MintParams` | Not yet implemented | Create/mint an NFT from a collection |
| `stake` | `StakeParams` | Not yet implemented | Delegate tokens to a validator |
| `custom` | `CustomParams` | Fully supported | Execute an arbitrary program instruction |

### TransactionIntent Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | No | Unique ID for idempotency (auto-generated UUID if omitted) |
| `type` | `IntentType` | Yes | The operation: `"transfer"`, `"swap"`, `"mint"`, `"stake"`, or `"custom"` |
| `chain` | `ChainId` | Yes | Target blockchain: `"solana"` (only fully supported option currently) |
| `params` | `IntentParams` | Yes | Operation-specific parameters (varies by type) |
| `metadata` | `IntentMetadata` | No | Context for audit logging and approval requests |
| `createdAt` | `number` | No | Timestamp (auto-assigned if omitted) |

### Type Guard Functions

| Function | Narrows `params` to | Use when |
|----------|---------------------|----------|
| `isTransferIntent(intent)` | `TransferParams` | You need to access `.to`, `.amount`, `.token` |
| `isSwapIntent(intent)` | `SwapParams` | You need to access `.fromToken`, `.toToken`, `.maxSlippage` |
| `isMintIntent(intent)` | `MintParams` | You need to access `.collection`, `.metadataUri` |
| `isStakeIntent(intent)` | `StakeParams` | You need to access `.validator`, `.amount`, `.token` |
| `isCustomIntent(intent)` | `CustomParams` | You need to access `.programId`, `.data`, `.accounts` |
