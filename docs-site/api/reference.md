# API Reference

Complete API reference for the kova TypeScript SDK, organized by module.

---

## Core

### AgentWallet

The main entry point for all wallet operations. Wraps a signer, chain adapter, policy engine, store, and optional approval channel into a single interface.

**Constructor:**

```typescript
new AgentWallet(config: AgentWalletConfig)
```

**AgentWalletConfig:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Cryptographic signer for transactions |
| `chain` | `ChainAdapter` | Yes | Blockchain adapter (e.g., SolanaAdapter) |
| `policy` | `PolicyEngine` | Yes | Policy engine that evaluates every transaction |
| `store` | `Store` | Yes | State storage for counters, logs, and audit entries |
| `approval` | `ApprovalChannel` | No | Approval channel for human-in-the-loop (e.g., TelegramApprovalBot) |
| `logger` | `AuditLogger` | No | Tamper-evident audit logger |
| `circuitBreaker` | `CircuitBreakerConfig` | No | Circuit breaker configuration |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback fired on audit integrity failures |

**Methods:**

#### `execute(intent: TransactionIntent): Promise<TransactionResult>`

Evaluate a transaction intent against the policy engine, sign it, and submit it to the blockchain.

```typescript
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "1.0",
    token: "SOL",
  },
});
// result.status: "confirmed" | "denied" | "pending" | "failed"
```

#### `getBalance(token: string): Promise<TokenBalance>`

Retrieve the balance for a specific token. Pass a token symbol (e.g., `"SOL"`) or a mint address.

```typescript
const balance = await wallet.getBalance("SOL");
// { token: "SOL", amount: "12.5", decimals: 9, usdValue: "2500.00" }
```

#### `getAddress(): Promise<string>`

Get the wallet's public address.

```typescript
const address = await wallet.getAddress();
// "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
```

#### `getPolicy(): Promise<PolicySummary>`

Get a summary of the active policy configuration.

```typescript
const summary = await wallet.getPolicy();
// { name: "my-policy", rules: [...], spendingLimit: {...}, ... }
```

#### `getTransactionHistory(limit?: number): Promise<TransactionResult[]>`

Retrieve recent transaction results from the audit log. Default limit is 10, maximum is 1000.

```typescript
const history = await wallet.getTransactionHistory(50);
```

#### `handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult>`

Execute a wallet tool by name. Used in AI tool-use loops.

```typescript
const result = await wallet.handleToolCall("wallet_get_balance", { token: "SOL" });
// { success: true, data: { token: "SOL", amount: "12.5", ... } }
```

#### `toAnthropicTools(): AnthropicTool[]`

Return tool definitions in Anthropic Messages API format.

```typescript
const tools = wallet.toAnthropicTools();
// Pass directly to anthropic.messages.create({ tools })
```

#### `toOpenAITools(): OpenAITool[]`

Return tool definitions in OpenAI function calling format.

```typescript
const tools = wallet.toOpenAITools();
// Pass directly to openai.chat.completions.create({ tools })
```

---

### TransactionIntent

Describes what the agent wants to do. Every call to `wallet.execute()` takes a `TransactionIntent`.

```typescript
interface TransactionIntent {
  id?: string;                  // Optional custom ID (auto-generated if omitted)
  type: IntentType;             // "transfer" | "swap" | "mint" | "stake" | "custom"
  chain: ChainId;               // "solana" (more chains in future)
  params: TransferParams | SwapParams | MintParams | StakeParams | CustomParams;
  metadata?: IntentMetadata;    // Optional key-value metadata
  createdAt?: string;           // ISO 8601 timestamp (auto-set if omitted)
}
```

#### IntentType

```typescript
type IntentType = "transfer" | "swap" | "mint" | "stake" | "custom";
```

#### ChainId

```typescript
type ChainId = "solana";
```

#### IntentMetadata

```typescript
interface IntentMetadata {
  [key: string]: string | number | boolean;
}
```

---

### Parameter Interfaces

#### TransferParams

```typescript
interface TransferParams {
  to: string;       // Recipient address
  amount: string;   // Amount as a string (e.g., "1.5")
  token: string;    // Token symbol or mint address
}
```

#### SwapParams

```typescript
interface SwapParams {
  fromToken: string;       // Source token symbol or mint address
  toToken: string;         // Destination token symbol or mint address
  amount: string;          // Amount of source token to swap
  maxSlippage?: number;    // Max acceptable slippage (0.01 = 1%)
}
```

#### MintParams

```typescript
interface MintParams {
  collection: string;      // Collection address or identifier
  quantity: number;         // Number of items to mint
  metadata?: Record<string, string>;  // Optional NFT metadata
}
```

#### StakeParams

```typescript
interface StakeParams {
  validator: string;       // Validator address
  amount: string;          // Amount to stake
  token: string;           // Token to stake
}
```

#### CustomParams

```typescript
interface CustomParams {
  programId: string;       // Program/contract address
  instruction: string;     // Instruction name or identifier
  data?: Record<string, unknown>;  // Arbitrary instruction data
}
```

---

### TransactionResult

Returned by `wallet.execute()` and stored in transaction history.

```typescript
interface TransactionResult {
  status: TransactionStatus;    // "confirmed" | "denied" | "pending" | "failed"
  txId?: string;                // On-chain transaction ID (when confirmed)
  summary: string;              // Human-readable summary
  intentId: string;             // ID of the original intent
  timestamp: string;            // ISO 8601 timestamp
  error?: TransactionError;     // Error details (when denied or failed)
}
```

#### TransactionStatus

```typescript
type TransactionStatus = "confirmed" | "denied" | "pending" | "failed";
```

| Status | Description |
|--------|-------------|
| `confirmed` | Transaction signed, submitted, and confirmed on-chain |
| `denied` | Policy engine rejected the transaction |
| `pending` | Awaiting approval (human-in-the-loop) |
| `failed` | Transaction was allowed but failed on-chain or during signing |

#### TransactionError

```typescript
interface TransactionError {
  code: TransactionErrorCode;
  message: string;
}
```

#### TransactionErrorCode

```typescript
type TransactionErrorCode =
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "SPENDING_LIMIT_EXCEEDED"
  | "ADDRESS_NOT_ALLOWED"
  | "PROGRAM_NOT_ALLOWED"
  | "RATE_LIMIT_EXCEEDED"
  | "OUTSIDE_TIME_WINDOW"
  | "APPROVAL_REJECTED"
  | "APPROVAL_TIMEOUT"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_FAILED"
  | "SIGNER_ERROR"
  | "CHAIN_ERROR"
  | "STORE_ERROR"
  | "CIRCUIT_BREAKER_OPEN"
  | "UNKNOWN_ERROR";
```

| Code | Category | Description |
|------|----------|-------------|
| `VALIDATION_FAILED` | Input | Intent structure is invalid |
| `POLICY_DENIED` | Policy | Generic policy denial |
| `SPENDING_LIMIT_EXCEEDED` | Policy | Per-transaction or daily limit exceeded |
| `ADDRESS_NOT_ALLOWED` | Policy | Recipient not on allowlist or is on denylist |
| `PROGRAM_NOT_ALLOWED` | Policy | Program not on allowlist or is on denylist |
| `RATE_LIMIT_EXCEEDED` | Policy | Too many transactions in the time window |
| `OUTSIDE_TIME_WINDOW` | Policy | Current time is outside active hours |
| `APPROVAL_REJECTED` | Approval | Human reviewer rejected the transaction |
| `APPROVAL_TIMEOUT` | Approval | No response within the timeout period |
| `INSUFFICIENT_BALANCE` | Chain | Wallet does not have enough tokens |
| `TRANSACTION_FAILED` | Chain | On-chain transaction execution failed |
| `SIGNER_ERROR` | Signer | Error during transaction signing |
| `CHAIN_ERROR` | Chain | RPC or network error |
| `STORE_ERROR` | Store | State storage read/write error |
| `CIRCUIT_BREAKER_OPEN` | Circuit | Circuit breaker is open, all transactions blocked |
| `UNKNOWN_ERROR` | System | Unexpected error |

---

### TokenBalance

Returned by `wallet.getBalance()`.

```typescript
interface TokenBalance {
  token: string;         // Token symbol or mint address
  amount: string;        // Balance as a string
  decimals: number;      // Token decimal places
  usdValue?: string;     // Optional USD value estimate
}
```

---

### PolicySummary

Returned by `wallet.getPolicy()`.

```typescript
interface PolicySummary {
  name: string;
  rules: string[];
  spendingLimit?: SpendingLimitConfig;
  allowAddresses?: AllowlistConfig;
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
  rateLimit?: RateLimitConfig;
  activeHours?: ActiveHoursConfig;
  requireApproval?: ApprovalGateConfig;
}
```

---

## Policy

### Policy

Static builder class for creating policy configurations.

#### `Policy.create(name: string): PolicyBuilder`

Create a new policy builder with the given name.

```typescript
const policy = Policy.create("my-policy")
  .spendingLimit({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  })
  .allowAddresses(["9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"])
  .denyAddresses(["BadActor111111111111111111111111111111111"])
  .allowPrograms(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"])
  .denyPrograms(["MaliciousProgram11111111111111111111111111"])
  .rateLimit({ maxTransactionsPerMinute: 10, maxTransactionsPerHour: 60 })
  .activeHours({
    timezone: "America/New_York",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  .requireApproval({ above: { amount: "10", token: "SOL" }, channel: "telegram", timeout: 300_000 })
  .build();
```

**PolicyBuilder methods:**

| Method | Parameter | Description |
|--------|-----------|-------------|
| `spendingLimit(config)` | `SpendingLimitConfig` | Set per-transaction, daily, weekly, and monthly spending limits |
| `allowAddresses(list)` | `string[]` | Whitelist of allowed recipient addresses |
| `denyAddresses(list)` | `string[]` | Blacklist of denied recipient addresses |
| `allowPrograms(list)` | `string[]` | Whitelist of allowed program/contract addresses |
| `denyPrograms(list)` | `string[]` | Blacklist of denied program/contract addresses |
| `rateLimit(config)` | `RateLimitConfig` | Transaction rate limiting |
| `activeHours(config)` | `ActiveHoursConfig` | Time-of-day restrictions |
| `requireApproval(config)` | `ApprovalGateConfig` | Human approval for high-value transactions |
| `build()` | -- | Returns a `Policy` instance |

#### `Policy.fromJSON(config: PolicyConfig): Policy`

Deserialize a policy from a JSON configuration object.

```typescript
const json = JSON.parse(readFileSync("policy.json", "utf-8"));
const policy = Policy.fromJSON(json);
```

#### `Policy.extend(base: Policy, name: string): PolicyBuilder`

Create a new builder pre-populated with settings from an existing policy. Override any settings on the builder before calling `build()`.

```typescript
const stricter = Policy.extend(basePolicy, "stricter-variant")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },
    daily: { amount: "5", token: "SOL" },
  })
  .build();
```

#### `policy.toJSON(): PolicyConfig`

Serialize the policy to a plain JSON object.

```typescript
const config = policy.toJSON();
writeFileSync("policy.json", JSON.stringify(config, null, 2));
```

#### `policy.getName(): string`

Get the policy name.

```typescript
const name = policy.getName();
// "my-policy"
```

#### `policy.getConfig(): Readonly<PolicyConfig>`

Get the full policy configuration as a read-only object.

```typescript
const config = policy.getConfig();
console.log(config.spendingLimit?.perTransaction?.amount);
```

---

### PolicyEngine

Evaluates transaction intents against a set of policy rules.

**Constructor:**

```typescript
new PolicyEngine(rules: PolicyRule[], store: Store, approval?: ApprovalChannel)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | `PolicyRule[]` | Yes | Array of rule instances to evaluate |
| `store` | `Store` | Yes | State store for rule counters and state |
| `approval` | `ApprovalChannel` | No | Approval channel for `ApprovalGateRule` |

**Methods:**

#### `evaluate(intent: TransactionIntent, context?: PolicyContext): Promise<PolicyEvaluationResult>`

Evaluate an intent against all rules.

```typescript
const result = await engine.evaluate(intent);
// result.decision: "ALLOW" | "DENY" | "PENDING"
// result.ruleAudits: PolicyRuleAudit[]
```

#### `getRuleNames(): string[]`

Get the names of all registered rules.

```typescript
const names = engine.getRuleNames();
// ["SpendingLimitRule", "AllowlistRule", "RateLimitRule"]
```

#### `getRules(): PolicyRule[]`

Get all registered rule instances.

```typescript
const rules = engine.getRules();
```

---

### PolicyEvaluationResult

```typescript
interface PolicyEvaluationResult {
  decision: PolicyDecision;
  ruleAudits: PolicyRuleAudit[];
}
```

### PolicyDecision

```typescript
type PolicyDecision = "ALLOW" | "DENY" | "PENDING";
```

| Decision | Description |
|----------|-------------|
| `ALLOW` | All rules passed, transaction may proceed |
| `DENY` | One or more rules rejected the transaction |
| `PENDING` | Transaction requires external approval |

### PolicyRuleAudit

```typescript
interface PolicyRuleAudit {
  ruleName: string;
  decision: PolicyDecision;
  reason?: string;
  metadata?: Record<string, unknown>;
}
```

---

### PolicyRule Interface

All policy rules implement this interface.

```typescript
interface PolicyRule {
  name: string;
  evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyRuleAudit>;
}
```

### PolicyContext

```typescript
interface PolicyContext {
  store: Store;
  walletAddress: string;
  approval?: ApprovalChannel;
  timestamp?: Date;
}
```

---

### SpendingLimitRule

Enforces per-transaction, daily, weekly, and monthly spending limits.

```typescript
new SpendingLimitRule(config: SpendingLimitConfig)
```

#### SpendingLimitConfig

```typescript
interface SpendingLimitConfig {
  perTransaction?: TokenAmount;  // Max amount per single transaction
  daily?: TokenAmount;           // Max total amount per rolling 24-hour window
  weekly?: TokenAmount;          // Max total amount per rolling 7-day window
  monthly?: TokenAmount;         // Max total amount per rolling 30-day window
}
```

#### TokenAmount

```typescript
interface TokenAmount {
  amount: string;
  token: string;
}
```

---

### AllowlistRule

Restricts transactions to a set of allowed recipient addresses.

```typescript
new AllowlistRule(config: AllowlistConfig)
```

#### AllowlistConfig

```typescript
interface AllowlistConfig {
  addresses: string[];    // Allowed recipient addresses
}
```

::: tip
When using `Policy.create()`, passing `allowAddresses(["addr1", "addr2"])` automatically creates the correct `AllowlistConfig`. When creating `AllowlistRule` directly, pass the config with the `addresses` array, or pass the string array directly from `policy.toJSON().allowAddresses`.
:::

---

### RateLimitRule

Limits the number of transactions per rolling time window.

```typescript
new RateLimitRule(config: RateLimitConfig)
```

#### RateLimitConfig

```typescript
interface RateLimitConfig {
  maxTransactionsPerMinute?: number;  // Max transactions per rolling minute
  maxTransactionsPerHour?: number;    // Max transactions per rolling hour
}
```

---

### TimeWindowRule

Restricts transactions to specified time windows.

```typescript
new TimeWindowRule(config: ActiveHoursConfig)
```

#### ActiveHoursConfig

```typescript
interface ActiveHoursConfig {
  timezone: string;                              // IANA timezone (e.g., "America/New_York")
  windows: TimeWindow[];                         // Array of allowed time windows
  outsideHoursPolicy?: "deny" | "require_approval"; // What to do outside windows (default: "deny")
}
```

#### TimeWindow

```typescript
interface TimeWindow {
  days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  start: string;            // "HH:MM" format (e.g., "09:00")
  end: string;              // "HH:MM" format (e.g., "17:00")
}
```

---

### ApprovalGateRule

Requires human approval for transactions above a threshold.

```typescript
new ApprovalGateRule(config: ApprovalGateConfig)
```

#### ApprovalGateConfig

```typescript
interface ApprovalGateConfig {
  above: TokenAmount;                          // Amount above which approval is required
  channel?: "telegram" | "slack" | "custom";   // Approval channel identifier
  timeout?: number;                            // Milliseconds to wait for approval (default: 300_000)
}
```

---

## Stores

### Store Interface

Abstract interface for state storage. All stores implement this interface.

```typescript
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  increment(key: string, amount?: number): Promise<number>;
  append(key: string, value: string): Promise<void>;
  getRecent(key: string, count: number): Promise<string[]>;
}
```

| Method | Description |
|--------|-------------|
| `get(key)` | Retrieve a value by key. Returns `null` if not found. |
| `set(key, value, ttl?)` | Store a value with optional TTL in seconds. |
| `increment(key, amount?)` | Atomically increment a numeric value. Returns the new value. |
| `append(key, value)` | Append a value to a list stored at key. |
| `getRecent(key, count)` | Get the most recent N entries from a list. |

---

### MemoryStore

In-memory implementation of `Store`. All data is lost when the process exits.

```typescript
new MemoryStore()
```

No configuration parameters. Ideal for development, testing, and ephemeral workloads.

```typescript
import { MemoryStore } from "kova";

const store = new MemoryStore();
```

---

### SqliteStore

Persistent implementation of `Store` backed by SQLite.

```typescript
new SqliteStore(config: SqliteStoreConfig)
```

#### SqliteStoreConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path for the SQLite database |

```typescript
import { SqliteStore } from "kova";

const store = new SqliteStore({
  path: "./data/kova.db",
});
```

::: warning
SQLite is single-writer. Do not share the same database file across multiple processes.
:::

---

## Signers

### Signer Interface

Abstract interface for transaction signing.

```typescript
interface Signer {
  getAddress(): Promise<string>;
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;
  healthCheck(): Promise<boolean>;
}
```

| Method | Description |
|--------|-------------|
| `getAddress()` | Returns the signer's public address |
| `sign(tx)` | Signs a transaction and returns the signed version |
| `healthCheck()` | Returns `true` if the signer is operational |

#### UnsignedTransaction

```typescript
interface UnsignedTransaction {
  chain: ChainId;
  data: Uint8Array | string;
  metadata?: Record<string, unknown>;
}
```

#### SignedTransaction

```typescript
interface SignedTransaction {
  chain: ChainId;
  data: Uint8Array | string;
  signature: string;
  metadata?: Record<string, unknown>;
}
```

---

### LocalSigner

Signs transactions using a local Solana keypair. The private key never leaves the process.

```typescript
new LocalSigner(keypair: Keypair)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keypair` | `Keypair` | Yes | Solana `Keypair` from `@solana/web3.js` |

```typescript
import { Keypair } from "@solana/web3.js";
import { LocalSigner } from "kova";

const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);

const address = await signer.getAddress();
const healthy = await signer.healthCheck(); // true
```

---

### MPCSigner

Signs transactions using a multi-party computation (MPC) service. The private key is split across multiple parties and never fully reconstructed.

```typescript
new MPCSigner(config: MPCSignerConfig)
```

#### MPCSignerConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `endpoint` | `string` | Yes | MPC service endpoint URL |
| `apiKey` | `string` | Yes | API key for authentication |
| `keyId` | `string` | Yes | Identifier of the MPC key share |
| `timeout` | `number` | No | Request timeout in milliseconds |

```typescript
import { MPCSigner } from "kova";

const signer = new MPCSigner({
  endpoint: "https://mpc.example.com",
  apiKey: process.env.MPC_API_KEY!,
  keyId: "key_abc123",
  timeout: 10000,
});
```

---

## Chains

### ChainAdapter Interface

Abstract interface for blockchain interactions.

```typescript
interface ChainAdapter {
  getBalance(address: string, token: string): Promise<TokenBalance>;
  submitTransaction(signed: SignedTransaction): Promise<TransactionStatusResult>;
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;
  buildTransaction(intent: TransactionIntent, address: string): Promise<UnsignedTransaction>;
}
```

| Method | Description |
|--------|-------------|
| `getBalance(address, token)` | Get token balance for an address |
| `submitTransaction(signed)` | Submit a signed transaction to the network |
| `getTransactionStatus(txId)` | Check the status of a submitted transaction |
| `buildTransaction(intent, address)` | Build an unsigned transaction from an intent |

#### TransactionStatusResult

```typescript
interface TransactionStatusResult {
  status: TransactionStatus;
  txId: string;
  confirmations?: number;
  error?: string;
}
```

---

### SolanaAdapter

Chain adapter for the Solana blockchain. Supports native SOL transfers, SPL token transfers, and Jupiter swaps.

```typescript
new SolanaAdapter(config: SolanaAdapterConfig)
```

#### SolanaAdapterConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rpcUrl` | `string` | Yes | Solana RPC endpoint URL |
| `commitment` | `string` | No | Commitment level: `"processed"`, `"confirmed"`, or `"finalized"` |
| `jupiterApiUrl` | `string` | No | Jupiter quote API URL (for swaps) |
| `jupiterPriceApiUrl` | `string` | No | Jupiter price API URL (for USD values) |

```typescript
import { SolanaAdapter } from "kova";

const chain = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "confirmed",
  jupiterApiUrl: "https://quote-api.jup.ag/v6",
  jupiterPriceApiUrl: "https://price.jup.ag/v6",
});
```

---

## Approval

### ApprovalChannel Interface

Abstract interface for human-in-the-loop approval.

```typescript
interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
```

#### ApprovalRequest

```typescript
interface ApprovalRequest {
  intentId: string;
  intent: TransactionIntent;
  walletAddress: string;
  reason: string;
  timeout: number;
}
```

#### ApprovalResult

```typescript
interface ApprovalResult {
  decision: ApprovalDecision;
  approvedBy?: string;
  reason?: string;
  timestamp: string;
}
```

#### ApprovalDecision

```typescript
type ApprovalDecision = "approved" | "rejected" | "timeout";
```

---

### TelegramApprovalBot

Sends approval requests as Telegram messages with inline Approve/Reject buttons.

```typescript
new TelegramApprovalBot(config: TelegramApprovalBotConfig)
```

#### TelegramApprovalBotConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | `string` | Yes | Telegram bot token from @BotFather |
| `chatId` | `string` | Yes | Chat ID to send approval requests to |
| `defaultTimeout` | `number` | No | Default timeout in ms (default: 300000 = 5 min) |
| `allowedUserIds` | `string[]` | No | User IDs allowed to approve/reject |
| `pollInterval` | `number` | No | Polling interval in ms for callback responses |

```typescript
import { TelegramApprovalBot } from "kova";

const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  defaultTimeout: 300000,
  allowedUserIds: ["123456789"],
  pollInterval: 2000,
});
```

---

## Adapters

### Tool Definitions

kova provides built-in tool definitions for AI model integrations.

#### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}
```

#### ToolParameter

```typescript
interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enum?: string[];
}
```

#### ToolCallResult

Returned by `wallet.handleToolCall()`.

```typescript
interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

---

### WALLET_TOOLS

Array of all built-in wallet tool definitions.

```typescript
import { WALLET_TOOLS } from "kova";
// ToolDefinition[]
```

### WALLET_TOOL_NAMES

Array of all tool name strings.

```typescript
import { WALLET_TOOL_NAMES } from "kova";
// ["wallet_get_balance", "wallet_get_address", "wallet_get_policy",
//  "wallet_transfer", "wallet_swap", "wallet_get_transaction_history"]
```

### WalletToolName

Union type of all valid tool names.

```typescript
type WalletToolName =
  | "wallet_get_balance"
  | "wallet_get_address"
  | "wallet_get_policy"
  | "wallet_transfer"
  | "wallet_swap"
  | "wallet_get_transaction_history";
```

### getToolByName

```typescript
function getToolByName(name: WalletToolName): ToolDefinition | undefined
```

Retrieve a specific tool definition by name.

```typescript
import { getToolByName } from "kova";

const transferTool = getToolByName("wallet_transfer");
```

---

### Anthropic Adapter

#### `toAnthropicTools(): AnthropicTool[]`

Instance method on `AgentWallet`. Returns tools in Anthropic Messages API format.

```typescript
const tools = wallet.toAnthropicTools();
```

#### AnthropicTool

```typescript
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}
```

---

### OpenAI Adapter

#### `toOpenAITools(): OpenAITool[]`

Instance method on `AgentWallet`. Returns tools in OpenAI function calling format.

```typescript
const tools = wallet.toOpenAITools();
```

#### OpenAITool

```typescript
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}
```

---

### LangChain Adapter

#### `createLangChainTools(wallet: AgentWallet): LangChainToolDefinition[]`

Standalone function that creates LangChain-compatible tool definitions.

```typescript
import { createLangChainTools } from "kova";

const tools = createLangChainTools(wallet);
```

#### LangChainToolDefinition

```typescript
interface LangChainToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  func: (input: Record<string, unknown>) => Promise<string>;
}
```

---

## Logging

### AuditLogger

Tamper-evident logger that creates a hash chain of audit entries. Each entry's hash depends on the previous entry, making it impossible to modify or delete entries without detection.

**Constructor (simple):**

```typescript
new AuditLogger(store: Store)
```

**Constructor (with config):**

```typescript
new AuditLogger(config: AuditLoggerConfig)
```

#### AuditLoggerConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `store` | `Store` | Yes | Storage backend for audit entries |
| `maxConsecutiveFailures` | `number` | No | Max write failures before triggering callback |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback fired when failures exceed threshold |

```typescript
import { AuditLogger } from "kova";

const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,
  onAuditFailure: (error) => {
    console.error("Audit failure:", error.message);
  },
});
```

**Methods:**

#### `verifyIntegrity(count: number): Promise<IntegrityReport>`

Verify the integrity of the most recent N audit entries by recalculating and comparing hashes.

```typescript
const report = await logger.verifyIntegrity(100);
console.log(report.valid);           // true or false
console.log(report.entriesChecked);  // 100
console.log(report.firstBrokenAt);  // undefined if valid
```

---

### AuditEntry

```typescript
interface AuditEntry {
  id: string;
  timestamp: string;
  intentId: string;
  intent: TransactionIntent;
  result: TransactionResult;
  policyAudits: PolicyRuleAudit[];
  hash: string;
  previousHash: string;
}
```

---

### IntegrityReport

```typescript
interface IntegrityReport {
  valid: boolean;                // Whether the entire chain is intact
  entriesChecked: number;        // Number of entries verified
  firstBrokenAt?: number;        // Index of first corrupted entry (if any)
}
```

---

### AuditCircuitOpenError

Error thrown when the audit logger's internal circuit breaker is open due to too many consecutive write failures.

```typescript
class AuditCircuitOpenError extends Error {
  readonly consecutiveFailures: number;
}
```

---

### AuditFailureCallback

```typescript
type AuditFailureCallback = (error: Error) => void;
```

---

## Circuit Breaker

### CircuitBreaker (Internal)

The `CircuitBreaker` class is **not directly exported** from kova. It is managed internally by `AgentWallet` when you pass a `circuitBreaker` config option. It automatically halts all transactions when consecutive failures exceed a threshold, protecting against cascading failures and network outages.

```typescript
// Not directly instantiated. Configured via AgentWallet:
```

::: tip
The `CircuitBreaker` is not exported and cannot be instantiated directly. Pass a `CircuitBreakerConfig` object to the `AgentWallet` constructor to enable circuit breaker protection.
:::

#### CircuitBreakerConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `maxConsecutiveFailures` | `number` | Yes | Number of consecutive failures before the circuit opens |
| `resetTimeoutMs` | `number` | Yes | Milliseconds before the circuit transitions to half-open |
| `halfOpenMaxAttempts` | `number` | No | Number of test transactions allowed in half-open state |

```typescript
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: {
    maxConsecutiveFailures: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxAttempts: 2,
  },
});
```

**States:**

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation. Failure counter increments on each failure, resets on success. |
| **Open** | All transactions rejected with `CIRCUIT_BREAKER_OPEN`. Transitions to half-open after `resetTimeoutMs`. |
| **Half-Open** | Allows `halfOpenMaxAttempts` test transactions. Success closes the circuit; failure reopens it. |
