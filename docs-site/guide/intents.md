# Transaction Intents

Transaction intents are high-level, declarative descriptions of what an agent wants to accomplish. Agents express _what_ they want, not _how_ to do it. The SDK handles all chain-specific details.

## TransactionIntent

```typescript
import type { TransactionIntent, IntentType, ChainId, IntentMetadata } from "kova";
```

```typescript
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

### IntentType

```typescript
type IntentType = "transfer" | "swap" | "mint" | "stake" | "custom";
```

### ChainId

```typescript
type ChainId = "solana" | "ethereum" | "base";
```

::: tip
Currently, only `"solana"` has a full chain adapter implementation. `"ethereum"` and `"base"` are defined as valid chain IDs for forward compatibility.
:::

## Intent Types

### Transfer

Send tokens from the wallet to a recipient address.

```typescript
interface TransferParams {
  /** Recipient wallet address */
  to: string;
  /** Human-readable amount (e.g., "1.5") */
  amount: string;
  /** Token symbol (e.g., "SOL", "USDC") or mint address */
  token: string;
}
```

Example:

```typescript
const transferIntent: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: "2.5",
    token: "SOL",
  },
  metadata: {
    reason: "Payment for data labeling task",
    agentId: "labeling-agent",
  },
};
```

### Swap

Exchange one token for another via a DEX (Jupiter on Solana).

```typescript
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

Example:

```typescript
const swapIntent: TransactionIntent = {
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "USDC",
    amount: "1.0",
    maxSlippage: 0.01,
  },
  metadata: {
    reason: "Converting SOL to stablecoin for payment",
  },
};
```

### Mint

Mint an NFT from a collection.

```typescript
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
const mintIntent: TransactionIntent = {
  type: "mint",
  chain: "solana",
  params: {
    collection: "DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4x",
    metadataUri: "https://arweave.net/abc123/metadata.json",
  },
};
```

::: warning
Mint operations on Solana are not yet fully implemented in the `SolanaAdapter`. The intent type exists for forward compatibility. Attempting to execute a mint intent will result in an "unsupported intent" error.
:::

### Stake

Stake tokens with a validator or staking pool.

```typescript
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
const stakeIntent: TransactionIntent = {
  type: "stake",
  chain: "solana",
  params: {
    amount: "10",
    token: "SOL",
    validator: "7Sys3UQhQbPz3azGKEHFBHL2uSrqxiSfNH7J4CYGHEeJ",
  },
};
```

::: warning
Stake operations on Solana are not yet fully implemented in the `SolanaAdapter`. The intent type exists for forward compatibility.
:::

### Custom

Execute an arbitrary program instruction (advanced use case).

```typescript
interface CustomParams {
  /** Program or contract address to interact with */
  programId: string;
  /** Instruction data (base64 encoded) */
  data: string;
  /** Accounts involved in the instruction */
  accounts: Array<{
    address: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
}
```

Example:

```typescript
const customIntent: TransactionIntent = {
  type: "custom",
  chain: "solana",
  params: {
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    data: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    accounts: [
      { address: "9WzDXwBb...", isSigner: false, isWritable: true },
      { address: "HN7cABqL...", isSigner: false, isWritable: false },
    ],
  },
};
```

::: danger
Custom intents bypass the SDK's high-level transaction building. The `data` and `accounts` are passed directly to the chain adapter. Ensure the instruction data is correct -- malformed instructions can lead to lost funds.
:::

## Intent Metadata

Optional metadata provides context for audit logging and approval requests.

```typescript
interface IntentMetadata {
  /** Why the agent wants to perform this action */
  reason?: string;
  /** Identifier for the agent that initiated the request */
  agentId?: string;
  /** Identifier for the task this is part of */
  taskId?: string;
  /** Urgency level — may influence approval timeout */
  urgency?: "low" | "normal" | "high";
}
```

Metadata is stored in the audit log and included in approval requests sent to humans. The `reason` field is particularly valuable -- it tells the human approver _why_ the agent wants to make the transaction.

```typescript
const intent: TransactionIntent = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: "5",
    token: "SOL",
  },
  metadata: {
    reason: "Purchasing training data from vendor",
    agentId: "ml-pipeline-agent",
    taskId: "task-2024-001",
    urgency: "normal",
  },
};
```

## Intent ID and Idempotency

Every intent is assigned a unique ID. If you provide an `id` field, it is used for idempotency. If omitted, a UUID is generated automatically.

**Idempotency behavior:**

- When an intent is executed, the result is cached in the store with the intent ID as the key and a 24-hour TTL.
- If the same intent ID is submitted again within 24 hours, the cached result is returned immediately without re-executing the pipeline.
- Only `confirmed` and `failed` results are cached. `denied` and `pending` results are NOT cached because the condition may change (e.g., rate limit expires, approval arrives).

```typescript
// First call: executes the full pipeline
const result1 = await wallet.execute({
  id: "payment-001",
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "1", token: "SOL" },
});

// Second call with same ID: returns cached result
const result2 = await wallet.execute({
  id: "payment-001",
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "1", token: "SOL" },
});

// result1 and result2 are identical
```

::: tip
Use deterministic intent IDs (e.g., derived from task IDs) to prevent duplicate transactions when retrying after network errors.
:::

## Intent ID Validation

If provided, the intent ID must be:

- A `string` type
- Between 1 and 128 characters long

Invalid intent IDs result in a `VALIDATION_FAILED` error.

## Type Guard Functions

The SDK exports type guard functions for narrowing intent types in TypeScript:

```typescript
import {
  isTransferIntent,
  isSwapIntent,
  isMintIntent,
  isStakeIntent,
  isCustomIntent,
} from "kova";

function describeIntent(intent: TransactionIntent): string {
  if (isTransferIntent(intent)) {
    // TypeScript knows intent.params is TransferParams here
    return `Transfer ${intent.params.amount} ${intent.params.token} to ${intent.params.to}`;
  }
  if (isSwapIntent(intent)) {
    // TypeScript knows intent.params is SwapParams here
    return `Swap ${intent.params.amount} ${intent.params.fromToken} for ${intent.params.toToken}`;
  }
  if (isMintIntent(intent)) {
    return `Mint NFT from ${intent.params.collection}`;
  }
  if (isStakeIntent(intent)) {
    return `Stake ${intent.params.amount} ${intent.params.token}`;
  }
  if (isCustomIntent(intent)) {
    return `Custom instruction to ${intent.params.programId}`;
  }
  return `Unknown intent type: ${intent.type}`;
}
```

Each type guard narrows the `params` field to the corresponding parameter interface, giving you full type safety when accessing operation-specific fields.
