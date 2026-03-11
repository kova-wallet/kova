# API Reference

Complete API reference for the kova TypeScript SDK, organized by module.

---

## Core

### AgentWallet

The main entry point for all wallet operations. Wraps a signer, chain adapter, policy engine, store, and optional approval channel into a single interface.

**Constructor:**

```typescript
// Create a new AgentWallet instance with the provided configuration.
// This is the main class you interact with -- it orchestrates signing,
// chain communication, policy enforcement, and audit logging.
new AgentWallet(config: AgentWalletConfig)
```

**AgentWalletConfig:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Cryptographic signer for transactions |
| `chain` | `ChainAdapter` | Yes | Blockchain adapter (e.g., SolanaAdapter) |
| `policy` | `Policy \| PolicyEngine` | Yes | Policy or policy engine that evaluates every transaction |
| `store` | `Store` | Yes | State storage for counters, logs, and audit entries |
| `approval` | `ApprovalChannel` | No | Approval channel for human-in-the-loop (e.g., CallbackApprovalChannel, WebhookApprovalChannel) |
| `logger` | `AuditLogger` | No | Tamper-evident audit logger |
| `circuitBreaker` | `Partial<CircuitBreakerConfig> \| { dangerouslyDisable: true } \| false` | No | Circuit breaker configuration. Use `{ dangerouslyDisable: true }` to disable. |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback fired on audit integrity failures |
| `enabledTools` | `ReadonlySet<string>` | No | Set of tool names to enable (defaults to `wallet_get_balance` and `wallet_get_transaction_history` only) |
| `idempotencyTtl` | `number` | No | TTL for idempotency cache entries in seconds |
| `idempotencyHmacKey` | `string \| Buffer` | No | HMAC-SHA256 key for verifying cached idempotency entries |
| `storePrefix` | `string` | No | Key prefix for multi-wallet store isolation |
| `mutexTimeoutMs` | `number` | No | Timeout for acquiring the execute mutex |
| `authToken` | `string` | No | Capability token for caller authentication |
| `dangerouslyDisableAuth` | `boolean` | No | Disable authentication token checks |
| `agentId` | `string` | No | Wallet-level agent identifier for circuit breaker and rate limit isolation |
| `verboseErrors` | `boolean` | No | Include full details in policy denial messages |
| `dangerouslyAllowVerboseErrorsInProduction` | `boolean` | No | Allow verbose errors in production |
| `dangerouslyAllowAutoHmacKey` | `boolean` | No | Allow auto-generation of idempotency HMAC key |
| `storeTimeoutMs` | `number` | No | Timeout for individual store operations |
| `strictAdvisoryLock` | `boolean` | No | Enforce strict advisory locking on store operations |
| `requireProgramAllowlistForCustom` | `boolean` | No | Require program allowlist for custom intents |

**Methods:**

#### `execute(intent: TransactionIntent, authToken?: string): Promise<TransactionResult>`

Evaluate a transaction intent against the policy engine, sign it, and submit it to the blockchain.

```typescript
// Execute a SOL transfer through the full pipeline:
// validate -> audit check -> circuit breaker -> policy -> build -> sign -> broadcast -> log
const result = await wallet.execute({
  type: "transfer",        // The operation type (transfer, swap, mint, stake, custom)
  chain: "solana",         // Target blockchain
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde", // Recipient address
    amount: "1.0",         // Amount in human-readable units (not lamports)
    token: "SOL",          // Token symbol
  },
});
// result.status: "confirmed" | "denied" | "pending" | "failed"
```

#### `getBalance(token: string): Promise<TokenBalance>`

Retrieve the balance for a specific token. Pass a token symbol (e.g., `"SOL"`) or a mint address.

```typescript
// Query the wallet's SOL balance. Internally delegates to chain.getBalance().
const balance = await wallet.getBalance("SOL");
// { token: "SOL", amount: "12.5", decimals: 9, usdValue: 2500.00 }
```

#### `getAddress(): Promise<string>`

Get the wallet's public address.

```typescript
// Returns the signer's public address (base58-encoded for Solana).
const address = await wallet.getAddress();
// "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
```

#### `getPolicy(): Promise<PolicySummary>`

Get a summary of the active policy configuration.

```typescript
// Retrieve the wallet's current policy rules and their configurations.
// Useful for AI agents to understand their constraints before acting.
const summary = await wallet.getPolicy();
// { name: "my-policy", rules: [...], spendingLimit: {...}, ... }
```

#### `getTransactionHistory(limit?: number): Promise<TransactionResult[]>`

Retrieve recent transaction results from the audit log. Default limit is 10, maximum is 1000.

```typescript
// Fetch the 50 most recent transaction results from the audit log.
// Returns an array of TransactionResult objects, newest first.
const history = await wallet.getTransactionHistory(50);
```

#### `handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult>`

Execute a wallet tool by name. Used in AI tool-use loops.

```typescript
// Dispatch a tool call from an AI agent to the appropriate wallet handler.
// This is the single entry point for all AI integrations (Claude, OpenAI, LangChain).
const result = await wallet.handleToolCall("wallet_get_balance", { token: "SOL" });
// { success: true, data: { token: "SOL", amount: "12.5", ... } }
```

#### `toAnthropicTools(): AnthropicTool[]`

Return tool definitions in Anthropic Messages API format.

```typescript
// Convert kova's wallet tools to Anthropic's format (uses input_schema).
// Pass the result directly to anthropic.messages.create({ tools }).
const tools = wallet.toAnthropicTools();
// Pass directly to anthropic.messages.create({ tools })
```

#### `toOpenAITools(): OpenAITool[]`

Return tool definitions in OpenAI function calling format.

```typescript
// Convert kova's wallet tools to OpenAI's format (uses { type: "function", function: {...} }).
// Pass the result directly to openai.chat.completions.create({ tools }).
const tools = wallet.toOpenAITools();
// Pass directly to openai.chat.completions.create({ tools })
```

---

### TransactionIntent

Describes what the agent wants to do. Every call to `wallet.execute()` takes a `TransactionIntent`.

```typescript
// A TransactionIntent is a high-level description of what the agent wants to do.
// The SDK converts this into chain-specific transaction bytes, evaluates it against
// policy rules, signs it, and broadcasts it.
interface TransactionIntent {
  id?: string;                  // Optional custom ID (auto-generated UUID if omitted)
  type: IntentType;             // The operation type: "transfer", "swap", "mint", "stake", or "custom"
  chain: ChainId;               // Target blockchain identifier (currently only "solana")
  params: TransferParams | SwapParams | MintParams | StakeParams | CustomParams; // Operation-specific parameters
  metadata?: IntentMetadata;    // Optional key-value metadata for audit and tracking purposes
  createdAt?: string;           // ISO 8601 timestamp (auto-set to current time if omitted)
}
```

#### IntentType

```typescript
// The types of operations the SDK supports.
// "transfer" = send tokens, "swap" = exchange tokens via DEX,
// "mint" = create NFTs, "stake" = delegate tokens, "custom" = raw program call
type IntentType = "transfer" | "swap" | "mint" | "stake" | "custom";
```

#### ChainId

```typescript
// Supported chain identifiers. "system" is used for internal/non-chain operations.
type ChainId = "solana" | "ethereum" | "base" | "system";
```

#### IntentMetadata

```typescript
// Named metadata fields attached to a transaction intent.
// Recorded in the audit log and useful for tracking, filtering,
// and correlating transactions with external systems.
interface IntentMetadata {
  reason?: string;    // Human-readable justification for the transaction
  agentId?: string;   // Identifies which AI agent initiated this transaction
  taskId?: string;    // External task or job identifier for correlation
}
```

---

### Parameter Interfaces

#### TransferParams

```typescript
// Parameters for a token transfer operation.
interface TransferParams {
  to: string;       // Recipient address (validated by chain adapter's isValidAddress())
  amount: string;   // Amount as a decimal string (e.g., "1.5"), not in raw units like lamports
  token: string;    // Token symbol (e.g., "SOL", "USDC") or mint address
}
```

#### SwapParams

```typescript
// Parameters for a token swap operation. Note: swaps are NOT built into SolanaAdapter;
// you must implement a custom ChainAdapter to handle swap intents (e.g., via Jupiter).
interface SwapParams {
  fromToken: string;       // Source token symbol or mint address (the token you're selling)
  toToken: string;         // Destination token symbol or mint address (the token you're buying)
  amount: string;          // Amount of the source token to swap (decimal string)
  maxSlippage?: number;    // Max acceptable slippage as a percentage (e.g., 0.5 = 0.5%). Default: 0.5
}
```

#### MintParams

```typescript
// Parameters for an NFT minting operation.
interface MintParams {
  collection: string;      // Collection address or identifier on-chain
  metadataUri: string;     // URI pointing to the NFT metadata (e.g., Arweave or IPFS link)
  to?: string;             // Optional recipient address (defaults to the wallet's own address)
}
```

#### StakeParams

```typescript
// Parameters for a staking operation.
interface StakeParams {
  amount: string;          // Amount to stake (decimal string)
  token: string;           // Token to stake (e.g., "SOL")
  validator?: string;      // Optional validator address to delegate stake to
}
```

#### CustomParams

```typescript
// Parameters for a custom on-chain program instruction.
interface CustomParams {
  programId: string;       // The on-chain program/contract address to call
  data: string;            // Instruction data to pass to the program
  accounts: Array<{        // Accounts required by the instruction
    address: string;       // Account public key (base58)
    isSigner: boolean;     // Whether this account must sign the transaction
    isWritable: boolean;   // Whether this account's data may be modified
  }>;
}
```

---

### TransactionResult

Returned by `wallet.execute()` and stored in transaction history.

```typescript
// The result of a transaction execution attempt.
// Contains the outcome, any on-chain transaction ID, and error details if applicable.
interface TransactionResult {
  status: TransactionStatus;    // The outcome: "confirmed", "denied", "pending", or "failed"
  txId?: string;                // On-chain transaction ID/signature (only when confirmed)
  summary: string;              // Human-readable summary (e.g., "Sent 1.5 SOL to 9aE4...gzM")
  intentId: string;             // ID of the original TransactionIntent for audit trail correlation
  timestamp: number;            // Milliseconds since epoch (Unix ms) of when the result was produced
  error?: TransactionError;     // Structured error details (only when denied or failed)
}
```

#### TransactionStatus

```typescript
// The four possible outcomes of a transaction execution attempt.
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
// Structured error information for denied or failed transactions.
interface TransactionError {
  code: TransactionErrorCode;   // Machine-readable error code for programmatic handling
  message: string;              // Human-readable error message
  policyRule?: string;          // Which policy rule caused the denial (e.g., "spending-limit")
  details?: Record<string, unknown>; // Additional error context
}
```

#### TransactionErrorCode

```typescript
// All possible error codes returned by the SDK.
// These are grouped by category: Input, Policy, Approval, Chain, Signer, Store, Circuit, System.
type TransactionErrorCode =
  | "VALIDATION_FAILED"       // Input: intent structure is invalid
  | "POLICY_DENIED"           // Policy: generic policy denial
  | "SPENDING_LIMIT_EXCEEDED" // Policy: per-transaction or daily limit exceeded
  | "ADDRESS_NOT_ALLOWED"     // Policy: recipient not on allowlist or is on denylist
  | "PROGRAM_NOT_ALLOWED"     // Policy: program not on allowlist or is on denylist
  | "RATE_LIMIT_EXCEEDED"     // Policy: too many transactions in the time window
  | "OUTSIDE_TIME_WINDOW"     // Policy: current time is outside active hours
  | "APPROVAL_REJECTED"       // Approval: human reviewer rejected the transaction
  | "APPROVAL_TIMEOUT"        // Approval: no response within the timeout period
  | "INSUFFICIENT_BALANCE"    // Chain: wallet does not have enough tokens
  | "SIMULATION_FAILED"       // Chain: transaction simulation failed before broadcast
  | "TRANSACTION_FAILED"      // Chain: on-chain transaction execution failed
  | "SIGNER_ERROR"            // Signer: error during transaction signing
  | "CHAIN_ERROR"             // Chain: RPC or network error
  | "STORE_ERROR"             // Store: state storage read/write error
  | "CIRCUIT_BREAKER_OPEN"    // Circuit: circuit breaker is open, all transactions blocked
  | "WALLET_DRAINING"         // System: wallet is shutting down, no new transactions accepted
  | "AUTH_FAILED"             // Auth: invalid or missing authentication token
  | "UNKNOWN_ERROR";          // System: unexpected error
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
| `SIMULATION_FAILED` | Chain | Transaction simulation failed before broadcast |
| `TRANSACTION_FAILED` | Chain | On-chain transaction execution failed |
| `SIGNER_ERROR` | Signer | Error during transaction signing |
| `CHAIN_ERROR` | Chain | RPC or network error |
| `STORE_ERROR` | Store | State storage read/write error |
| `CIRCUIT_BREAKER_OPEN` | Circuit | Circuit breaker is open, all transactions blocked |
| `WALLET_DRAINING` | System | Wallet is shutting down, no new transactions accepted |
| `AUTH_FAILED` | Auth | Invalid or missing authentication token |
| `UNKNOWN_ERROR` | System | Unexpected error |

---

### TokenBalance

Returned by `wallet.getBalance()`.

```typescript
// Represents the balance of a specific token held by the wallet.
interface TokenBalance {
  token: string;         // Token symbol (e.g., "SOL") or mint address
  amount: string;        // Balance as a decimal string (e.g., "12.5")
  decimals: number;      // Token decimal places (9 for SOL, 6 for USDC)
  usdValue?: number;     // Optional USD value estimate from the price oracle
}
```

---

### PolicySummary

Returned by `wallet.getPolicy()`.

```typescript
// A human-readable summary of the wallet's active policy configuration.
// This is what the AI agent sees when it calls wallet_get_policy.
interface PolicySummary {
  name: string;                             // Policy name (e.g., "my-policy")
  spendingLimits: {                         // Spending limit configuration
    perTransaction?: TokenAmount;
    daily?: TokenAmount;
    weekly?: TokenAmount;
    monthly?: TokenAmount;
  };
  allowlistedAddresses: number;             // Count of allowlisted recipient addresses
  allowlistedPrograms: number;              // Count of allowlisted program addresses
  approvalRequired?: TokenAmount;           // Threshold above which human approval is needed
  rateLimits?: RateLimitConfig;             // Rate limit configuration (if any)
  activeHours?: ActiveHoursConfig;          // Time window restrictions (if any)
  circuitBreaker?: unknown;                 // Circuit breaker status and configuration
}
```

---

## Policy

### Policy

Static builder class for creating policy configurations.

#### `Policy.create(name: string): PolicyBuilder`

Create a new policy builder with the given name.

```typescript
// Use the fluent builder pattern to create a comprehensive policy.
// Each method adds a rule or constraint, and build() produces the final Policy object.
const policy = Policy.create("my-policy")
  // Set spending limits: max 5 SOL per transaction, 50 SOL per day.
  .spendingLimit({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  })
  // Only allow transfers to this specific address.
  .allowAddresses(["9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"])
  // Block transfers to known bad actors.
  .denyAddresses(["BadActor111111111111111111111111111111111"])
  // Only allow interaction with the Jupiter DEX aggregator program.
  .allowPrograms(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"])
  // Block interaction with known malicious programs.
  .denyPrograms(["MaliciousProgram11111111111111111111111111"])
  // Rate limit: max 10 transactions per minute, 60 per hour.
  .rateLimit({ maxTransactionsPerMinute: 10, maxTransactionsPerHour: 60 })
  // Only allow transactions during business hours (Eastern time, Mon-Fri 9am-5pm).
  .activeHours({
    timezone: "America/New_York",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  })
  // Require human approval for transfers above 10 SOL.
  .requireApproval({ above: { amount: "10", token: "SOL" }, timeout: 300_000 })
  // Finalize and return the Policy instance.
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
// Load a policy from a JSON file. This allows policy configuration to be
// managed outside of code (e.g., in a config file or database).
const json = JSON.parse(readFileSync("policy.json", "utf-8"));
const policy = Policy.fromJSON(json);
```

#### `Policy.extend(base: Policy, name: string): PolicyBuilder`

Create a new builder pre-populated with settings from an existing policy. Override any settings on the builder before calling `build()`.

```typescript
// Create a stricter variant of an existing policy by overriding specific settings.
// All settings from basePolicy are inherited unless explicitly overridden.
const stricter = Policy.extend(basePolicy, "stricter-variant")
  // Override the spending limits with much lower values.
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },  // Reduced from 5 to 1 SOL
    daily: { amount: "5", token: "SOL" },            // Reduced from 50 to 5 SOL
  })
  .build();
```

#### `policy.toJSON(): PolicyConfig`

Serialize the policy to a plain JSON object.

```typescript
// Export the policy configuration to JSON for persistence or sharing.
// The output can be passed to Policy.fromJSON() to recreate the policy.
const config = policy.toJSON();
writeFileSync("policy.json", JSON.stringify(config, null, 2));
```

#### `policy.getName(): string`

Get the policy name.

```typescript
// Retrieve the policy's name (set when created via Policy.create() or Policy.extend()).
const name = policy.getName();
// "my-policy"
```

#### `policy.getConfig(): Readonly<PolicyConfig>`

Get the full policy configuration as a read-only object.

```typescript
// Access the full policy configuration for inspection.
// The returned object is read-only -- you cannot modify the policy through it.
const config = policy.getConfig();
console.log(config.spendingLimit?.perTransaction?.amount);
```

---

### PolicyEngine

Evaluates transaction intents against a set of policy rules.

**Constructor:**

```typescript
// Create a PolicyEngine with an array of rules, a store for persisting state,
// and optional parameters for approval, price conversion, and timeouts.
new PolicyEngine(rules: PolicyRule[], store: Store, approval?: ApprovalChannel, getValueInUSD?: Function, mutexTimeoutMs?: number, storeOpTimeoutMs?: number, minEvaluationTimeMs?: number)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | `PolicyRule[]` | Yes | Array of rule instances to evaluate |
| `store` | `Store` | Yes | State store for rule counters and state |
| `approval` | `ApprovalChannel` | No | Approval channel for `ApprovalGateRule` |
| `getValueInUSD` | `(token: string, amount: string) => Promise<number>` | No | Function to convert token amounts to USD |
| `mutexTimeoutMs` | `number` | No | Timeout for acquiring the evaluation mutex |
| `storeOpTimeoutMs` | `number` | No | Timeout for individual store operations during evaluation |
| `minEvaluationTimeMs` | `number` | No | Minimum evaluation time to prevent timing side-channel attacks |

**Methods:**

#### `evaluate(intent: TransactionIntent, now?: number): Promise<PolicyEvaluationResult>`

Evaluate an intent against all rules.

```typescript
// Evaluate a transaction intent against every registered policy rule.
// Rules are evaluated in order; if any rule returns DENY, evaluation stops.
const result = await engine.evaluate(intent);
// result.decision: "ALLOW" | "DENY" | "PENDING"
// result.ruleAudits: PolicyRuleAudit[] -- one entry per evaluated rule
```

#### `getRuleNames(): string[]`

Get the names of all registered rules.

```typescript
// List all rule names for debugging or introspection.
const names = engine.getRuleNames();
// ["SpendingLimitRule", "AllowlistRule", "RateLimitRule"]
```

#### `getRules(): PolicyRule[]`

Get all registered rule instances.

```typescript
// Access the actual rule instances for advanced inspection.
const rules = engine.getRules();
```

---

### PolicyEvaluationResult

```typescript
// The result of evaluating a transaction intent against all policy rules.
interface PolicyEvaluationResult {
  decision: PolicyDecision;       // The aggregate decision: ALLOW, DENY, or PENDING
  ruleAudits: PolicyRuleAudit[];  // Per-rule evaluation results
}
```

### PolicyDecision

```typescript
// The three possible aggregate decisions from policy evaluation.
type PolicyDecision = "ALLOW" | "DENY" | "PENDING";
```

| Decision | Description |
|----------|-------------|
| `ALLOW` | All rules passed, transaction may proceed |
| `DENY` | One or more rules rejected the transaction |
| `PENDING` | Transaction requires external approval |

### PolicyRuleAudit

```typescript
// Records the result of a single rule evaluation.
interface PolicyRuleAudit {
  ruleName: string;                    // Which rule was evaluated
  decision: PolicyDecision;            // This rule's individual decision
  reason?: string;                     // Explanation (for DENY decisions)
  metadata?: Record<string, unknown>;  // Additional rule-specific data
}
```

---

### PolicyRule Interface

All policy rules implement this interface.

```typescript
// The interface every policy rule must implement.
// Each rule receives a transaction intent and context, and returns
// its individual evaluation result (ALLOW, DENY, or PENDING).
interface PolicyRule {
  name: string;  // The rule's unique name (e.g., "spending-limit", "allowlist")
  evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyRuleAudit>;
}
```

### PolicyContext

```typescript
// Context provided to each policy rule during evaluation.
// Contains the store for reading/writing rule state, the wallet address,
// and an optional approval channel for rules that need human input.
interface PolicyContext {
  store: Store;                    // State store for persisting rule counters and data
  walletAddress: string;           // The wallet's public address
  approval?: ApprovalChannel;     // Optional approval channel for ApprovalGateRule
  timestamp?: Date;               // Optional override of the current time (useful for testing)
}
```

---

### SpendingLimitRule

Enforces per-transaction, daily, weekly, and monthly spending limits.

```typescript
// Create a SpendingLimitRule with the given configuration.
// This rule checks the transaction amount against configured limits
// and tracks cumulative spending using the store.
new SpendingLimitRule(config: SpendingLimitConfig)
```

#### SpendingLimitConfig

```typescript
// Configuration for spending limits across multiple time windows.
// Each field is optional -- only configure the limits you need.
interface SpendingLimitConfig {
  perTransaction?: TokenAmount;  // Max amount per single transaction
  daily?: TokenAmount;           // Max total amount per rolling 24-hour window
  weekly?: TokenAmount;          // Max total amount per rolling 7-day window
  monthly?: TokenAmount;         // Max total amount per rolling 30-day window
}
```

#### TokenAmount

```typescript
// A token amount used in spending limit and approval threshold configurations.
interface TokenAmount {
  amount: string;   // The limit amount as a decimal string (e.g., "10.0")
  token: string;    // The token symbol this limit applies to (e.g., "SOL")
}
```

---

### AllowlistRule

Restricts transactions to a set of allowed recipient addresses.

```typescript
// Create an AllowlistRule that only permits transfers to the specified addresses.
// Transfers to any other address are denied with ADDRESS_NOT_ALLOWED.
new AllowlistRule(config: AllowlistConfig)
```

#### AllowlistConfig

```typescript
// Configuration for the address allowlist.
interface AllowlistConfig {
  addresses: string[];    // Array of allowed recipient addresses (Solana base58 public keys)
}
```

::: tip
When using `Policy.create()`, passing `allowAddresses(["addr1", "addr2"])` automatically creates the correct `AllowlistConfig`. When creating `AllowlistRule` directly, pass the config with the `addresses` array, or pass the string array directly from `policy.toJSON().allowAddresses`.
:::

---

### RateLimitRule

Limits the number of transactions per rolling time window.

```typescript
// Create a RateLimitRule that restricts transaction frequency.
// Uses the store to track transaction counts per time window.
new RateLimitRule(config: RateLimitConfig)
```

#### RateLimitConfig

```typescript
// Configuration for transaction rate limiting.
// Each field is optional -- configure only the windows you need.
interface RateLimitConfig {
  maxTransactionsPerMinute?: number;  // Max transactions allowed per rolling 60-second window
  maxTransactionsPerHour?: number;    // Max transactions allowed per rolling 3600-second window
}
```

---

### TimeWindowRule

Restricts transactions to specified time windows.

```typescript
// Create a TimeWindowRule that only allows transactions during specific time windows.
// Transactions outside the configured windows are denied (or require approval).
new TimeWindowRule(config: ActiveHoursConfig)
```

#### ActiveHoursConfig

```typescript
// Configuration for time-of-day transaction restrictions.
interface ActiveHoursConfig {
  timezone: string;                              // IANA timezone (e.g., "America/New_York", "UTC")
  windows: TimeWindow[];                         // Array of allowed time windows
  outsideHoursPolicy?: "deny" | "require_approval"; // What to do outside windows (default: "deny")
}
```

#### TimeWindow

```typescript
// A single time window during which transactions are allowed.
interface TimeWindow {
  days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">; // Active days of the week
  start: string;            // Start time in "HH:MM" format (e.g., "09:00")
  end: string;              // End time in "HH:MM" format (e.g., "17:00")
}
```

---

### ApprovalGateRule

Requires human approval for transactions above a threshold.

```typescript
// Create an ApprovalGateRule that triggers human approval for high-value transactions.
// When triggered, the SDK sends a request through the configured ApprovalChannel.
new ApprovalGateRule(config: ApprovalGateConfig)
```

#### ApprovalGateConfig

```typescript
// Configuration for the human approval gate.
interface ApprovalGateConfig {
  above: TokenAmount;                          // Amount above which approval is required
  channel?: string;                              // Approval channel identifier (for documentation only)
  timeout?: number;                            // Milliseconds to wait for approval (default: 300_000 = 5 min)
}
```

---

## Stores

### Store Interface

Abstract interface for state storage. All stores implement this interface.

```typescript
// The Store interface that all persistence backends must implement.
// Used by the PolicyEngine, AuditLogger, CircuitBreaker, and AgentWallet
// to persist their internal state across process restarts.
interface Store {
  get(key: string): Promise<string | null>;                      // Get a value by key (null if not found or expired)
  set(key: string, value: string, ttlSeconds?: number): Promise<void>; // Set a value with optional TTL
  setIfNotExists(key: string, value: string, ttlSeconds?: number): Promise<boolean>; // Atomic conditional write
  increment(key: string, amount?: number): Promise<number>;       // Atomically increment a numeric value
  append(key: string, value: string): Promise<void>;              // Append to an ordered list
  getRecent(key: string, count: number): Promise<string[]>;       // Get the N most recent list entries
  clearList(key: string): Promise<void>;                          // Clear a list (required)
}
```

| Method | Description |
|--------|-------------|
| `get(key)` | Retrieve a value by key. Returns `null` if not found. |
| `set(key, value, ttl?)` | Store a value with optional TTL in seconds. |
| `setIfNotExists(key, value, ttl?)` | Atomic conditional write. Returns `true` if set, `false` if key already exists. |
| `increment(key, amount?)` | Atomically increment a numeric value. Returns the new value. |
| `append(key, value)` | Append a value to a list stored at key. |
| `getRecent(key, count)` | Get the most recent N entries from a list. |
| `clearList(key)` | Clear all entries in a list. Required method. |

---

### MemoryStore

In-memory implementation of `Store`. All data is lost when the process exits.

```typescript
// No configuration needed -- data lives in JavaScript objects within the process.
new MemoryStore()
```

No configuration parameters. Ideal for development, testing, and ephemeral workloads.

```typescript
// Import and create an in-memory store.
// Fast and simple, but all data is lost on process restart.
import { MemoryStore } from "@kova/wallet";

const store = new MemoryStore();
```

---

### SqliteStore

Persistent implementation of `Store` backed by SQLite.

```typescript
// Create a persistent store backed by an SQLite database file.
// Requires the better-sqlite3 npm package.
new SqliteStore(config: SqliteStoreConfig)
```

#### SqliteStoreConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path for the SQLite database |

```typescript
// Import and create a file-backed SQLite store.
// The database file is created automatically if it doesn't exist.
import { SqliteStore } from "@kova/wallet";

const store = new SqliteStore({
  path: "./data/kova.db",  // Path to the SQLite database file
});
```

::: warning
SQLite is single-writer. Do not share the same database file across multiple processes. For multi-process deployments, use `RedisStore`.
:::

---

### RedisStore

Redis-backed implementation of `Store` for multi-process production deployments. Requires the `ioredis` optional peer dependency.

```typescript
// Create a Redis-backed store. Requires ioredis: npm install ioredis
new RedisStore(config?: RedisStoreConfig)
```

#### RedisStoreConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `client` | `Redis` | No | An existing ioredis client instance (for Sentinel, Cluster, etc.). RedisStore will not close it on `disconnect()`. |
| `url` | `string` | No | Redis connection URL. Ignored if `client` is provided. Defaults to `localhost:6379`. |
| `keyPrefix` | `string` | No | Prefix for all Redis keys (e.g., `"kova:"`). For application-level namespacing. |
| `listPrefix` | `string` | No | Internal prefix for list keys. Default: `"list:"`. |

```typescript
// Import and create a Redis-backed store.
import { RedisStore } from "@kova/wallet";

// Simple: connect with a URL
const store = new RedisStore({ url: "redis://localhost:6379" });

// Advanced: bring your own ioredis client
import Redis from "ioredis";
const client = new Redis.Cluster([{ host: "redis-1", port: 6379 }]);
const store = new RedisStore({ client });
```

**Methods** (in addition to `Store` interface):

| Method | Description |
|--------|-------------|
| `disconnect()` | Close the Redis connection. Only closes if RedisStore created it. |

---

## Signers

### Signer Interface

Abstract interface for transaction signing.

```typescript
// The Signer interface that all key management backends must implement.
// Abstracts away how the private key is stored and how signing is performed.
interface Signer {
  getAddress(): Promise<string>;                                  // Get the signer's public address
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>; // Sign a transaction
  healthCheck(): Promise<boolean>;                                 // Check if the signer is operational
  destroy(): Promise<void>;                                        // Zero out key material (async)
  toJSON(): Record<string, unknown>;                               // Safe JSON serialization (no secrets)
}
```

| Method | Description |
|--------|-------------|
| `getAddress()` | Returns the signer's public address |
| `sign(tx)` | Signs a transaction and returns the signed version |
| `healthCheck()` | Returns `true` if the signer is operational |
| `destroy()` | Zero out key material and prevent further signing. Returns `Promise<void>`. |
| `toJSON()` | Safe JSON serialization -- never includes the secret key |

#### UnsignedTransaction

```typescript
// A transaction that has been built but not yet signed.
// Contains chain-specific serialized bytes.
interface UnsignedTransaction {
  chain: ChainId;                          // Which blockchain this transaction targets
  data: Uint8Array | string;               // The raw transaction bytes to be signed
  metadata?: Record<string, unknown>;      // Optional metadata for logging/tracking
}
```

#### SignedTransaction

```typescript
// A fully signed transaction ready for submission to the blockchain.
interface SignedTransaction {
  chain: ChainId;                          // Which blockchain this transaction targets
  data: Uint8Array | string;               // The complete signed transaction bytes
  signature: string;                       // The cryptographic signature (base58 for Solana)
  metadata?: Record<string, unknown>;      // Optional metadata for logging/tracking
}
```

---

### LocalSigner

Signs transactions using a local Solana keypair. The private key never leaves the process.

```typescript
// Create a LocalSigner from a Solana Keypair.
// The keypair is held in process memory -- use only for development.
new LocalSigner(keypair: Keypair)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keypair` | `Keypair` | Yes | Solana `Keypair` from `@solana/web3.js` |

```typescript
// Import Keypair from Solana's web3.js library and LocalSigner from kova.
import { Keypair } from "@solana/web3.js";
import { LocalSigner } from "@kova/wallet";

// Generate a new random keypair for development/testing.
const keypair = Keypair.generate();
// Wrap it in a LocalSigner to implement the Signer interface.
const signer = new LocalSigner(keypair);

// Get the wallet's public address (base58-encoded).
const address = await signer.getAddress();
// Health check always returns true for LocalSigner (key is in memory).
const healthy = await signer.healthCheck(); // true
```

---

### MPCSigner

Signs transactions using a multi-party computation (MPC) service. The private key is split across multiple parties and never fully reconstructed.

```typescript
// Create an MPCSigner connected to an MPC service.
// Note: This is currently a stub -- Phase 2 implementation pending.
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
// Import MPCSigner from kova.
import { MPCSigner } from "@kova/wallet";

// Create an MPCSigner instance pointing to your MPC service.
// In production, the private key is split across multiple parties
// and never reconstructed on any single machine.
const signer = new MPCSigner({
  endpoint: "https://mpc.example.com",     // MPC service URL
  apiKey: process.env.MPC_API_KEY!,        // Authentication key
  keyId: "key_abc123",                     // Which key share to use
  timeout: 10000,                          // 10-second request timeout
});
```

---

## Chains

### ChainAdapter Interface

Abstract interface for blockchain interactions.

```typescript
// The ChainAdapter interface abstracts all blockchain-specific operations.
// Each supported blockchain has its own adapter implementation.
interface ChainAdapter {
  readonly chain: ChainId;                                                      // Chain identifier
  getBalance(address: string, token: string): Promise<TokenBalance>;           // Query token balance
  getValueInUSD(token: string, amount: string): Promise<number>;               // Price oracle
  buildTransaction(intent: TransactionIntent, signerAddress: string): Promise<UnsignedTransaction>; // Build unsigned tx from intent
  simulateTransaction(txData: Uint8Array): Promise<SimulationResult>;          // Pre-flight check
  broadcast(signedTxData: Uint8Array): Promise<string>;                        // Submit and get tx ID
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;         // Check transaction status
  isValidAddress(address: string): boolean;                                    // Address validation
  verifyTransactionIntegrity(intent: TransactionIntent, transaction: UnsignedTransaction, signerAddress: string): Promise<void>; // Verify tx matches intent
  refreshBlockhash?(transaction: UnsignedTransaction): Promise<UnsignedTransaction>; // Optional: refresh blockhash
  destroy?(): Promise<void>;                                                   // Optional: clean up resources
}
```

| Method | Description |
|--------|-------------|
| `chain` | Read-only `ChainId` identifying which blockchain this adapter targets |
| `getBalance(address, token)` | Get token balance for an address |
| `getValueInUSD(token, amount)` | Convert a token amount to its USD equivalent |
| `buildTransaction(intent, address)` | Build an unsigned transaction from an intent |
| `simulateTransaction(txData)` | Simulate a transaction without broadcasting |
| `broadcast(signedTxData)` | Submit a signed transaction to the network, returns tx ID |
| `getTransactionStatus(txId)` | Check the status of a submitted transaction |
| `isValidAddress(address)` | Validate an address for this chain |
| `verifyTransactionIntegrity(intent, tx, address)` | Verify built transaction matches the original intent |
| `refreshBlockhash?(tx)` | Optional: refresh an expired blockhash |
| `destroy?()` | Optional: clean up resources |

#### TransactionStatusResult

```typescript
// Detailed status of a submitted transaction.
interface TransactionStatusResult {
  status: TransactionStatus;     // Current confirmation state
  txId: string;                  // On-chain transaction ID
  confirmations?: number;        // Number of confirmations (if applicable)
  error?: string;                // Error message if the transaction failed
}
```

---

### SolanaAdapter

Chain adapter for the Solana blockchain. Supports native SOL transfers and SPL token transfers. Swap, mint, and stake operations require a custom `ChainAdapter` implementation.

```typescript
// Create a SolanaAdapter connected to a Solana RPC endpoint.
new SolanaAdapter(config: SolanaAdapterConfig)
```

#### SolanaAdapterConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rpcUrl` | `string` | Yes | Solana RPC endpoint URL |
| `commitment` | `string` | No | Commitment level: `"processed"`, `"confirmed"`, or `"finalized"` |
| `network` | `string` | No | Network selection: `"mainnet-beta"`, `"devnet"`, `"testnet"`, or `"auto"` |
| `dnsCache` | `Map` | No | Per-instance DNS cache for multi-tenant isolation |
| `priceProvider` | `(token: string) => Promise<number \| null>` | No | Price oracle for USD valuation |

```typescript
// Import and configure the Solana adapter with a Pyth price oracle.
import { SolanaAdapter, createPythPriceProvider } from "@kova/wallet";
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const chain = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",  // Solana mainnet RPC
  commitment: "confirmed",                         // Wait for supermajority confirmation
  priceProvider: createPythPriceProvider(connection), // Pyth on-chain price oracle
});
```

---

## Approval

### ApprovalChannel Interface

Abstract interface for human-in-the-loop approval.

```typescript
// The ApprovalChannel interface that all approval backends must implement.
// Each implementation handles sending requests and collecting responses
// through a specific platform (Slack, email, webhook, etc.).
interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
```

#### ApprovalRequest

```typescript
// The data sent to the human approver when approval is required.
interface ApprovalRequest {
  intentId: string;              // ID of the transaction intent awaiting approval
  intent: TransactionIntent;     // The full intent details
  walletAddress: string;         // The wallet's public address
  reason: string;                // Why approval is needed (e.g., "Amount exceeds 10 SOL threshold")
  timeout: number;               // Milliseconds before the request auto-expires
}
```

#### ApprovalResult

```typescript
// The human's response to an approval request.
interface ApprovalResult {
  decision: ApprovalDecision;    // "approved", "rejected", or "timeout"
  approvedBy?: string;           // Who made the decision (e.g., Slack user ID, webhook caller)
  reason?: string;               // Optional reason for the decision
  timestamp: string;             // ISO 8601 timestamp of the decision
}
```

#### ApprovalDecision

```typescript
// The three possible outcomes of an approval request.
type ApprovalDecision = "approved" | "rejected" | "timeout";
```

---

### CallbackApprovalChannel

Flexible approval channel that uses two callbacks: one to notify a human, one to wait for their decision.

```typescript
new CallbackApprovalChannel(config: CallbackApprovalChannelConfig)
```

#### CallbackApprovalChannelConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | No | Channel name for audit logs (default: `"callback"`) |
| `onApprovalRequest` | `(request: ApprovalRequest) => Promise<void>` | Yes | Callback to notify a human approver |
| `waitForDecision` | `(request: ApprovalRequest) => Promise<ApprovalResult>` | Yes | Callback to wait for the human's decision |
| `defaultTimeout` | `number` | No | Default timeout in ms (default: 300000 = 5 min) |

```typescript
import { CallbackApprovalChannel } from "@kova/wallet";

const approval = new CallbackApprovalChannel({
  name: "my-approval",
  onApprovalRequest: async (request) => {
    await notifyApprover(request);
  },
  waitForDecision: async (request) => {
    return pollForResponse(request.id);
  },
  defaultTimeout: 300_000,
});
```

### WebhookApprovalChannel

HTTP webhook-based approval for systems that communicate via HTTP callbacks.

```typescript
new WebhookApprovalChannel(config: WebhookApprovalChannelConfig)
```

#### WebhookApprovalChannelConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | No | Channel name for audit logs (default: `"webhook"`) |
| `webhookUrl` | `string` | Yes | URL to POST approval requests to |
| `hmacSecret` | `string` | Yes | Shared secret for HMAC-SHA256 signing (min 16 chars) |
| `callbackPort` | `number` | No | Port for callback server (0 = OS-assigned) |
| `callbackPath` | `string` | No | Path for incoming decision callbacks |
| `defaultTimeout` | `number` | No | Default timeout in ms (default: 300000 = 5 min) |

```typescript
import { WebhookApprovalChannel } from "@kova/wallet";

const approval = new WebhookApprovalChannel({
  webhookUrl: "https://your-approval-service.com/approve",
  hmacSecret: process.env.APPROVAL_HMAC_SECRET!,
  callbackPort: 0,
  defaultTimeout: 300_000,
});

await approval.start();
```

---

## Adapters

### Tool Definitions

kova provides built-in tool definitions for AI model integrations.

#### ToolDefinition

```typescript
// The canonical tool definition format used internally by kova.
// Provider-specific adapters convert this to the format each AI service expects.
interface ToolDefinition {
  name: string;                    // Tool name (e.g., "wallet_transfer")
  description: string;             // Description sent to the LLM
  parameters: ToolParameter[];     // Array of parameter definitions
}
```

#### ToolParameter

```typescript
// Schema for a single tool parameter.
interface ToolParameter {
  name: string;           // Parameter name (e.g., "to", "amount")
  type: string;           // JSON Schema type (e.g., "string", "number")
  description: string;    // Description shown to the LLM to guide usage
  required: boolean;      // Whether this parameter is mandatory
  enum?: string[];        // Optional: restrict to specific values (e.g., chain names)
}
```

#### WalletToolDefinition

Exported type alias for `ToolDefinition`, used when referencing wallet-specific tool definitions.

```typescript
// Type alias for wallet tool definitions.
type WalletToolDefinition = ToolDefinition;
```

#### ToolCallResult

Returned by `wallet.handleToolCall()`.

```typescript
// The standardized response format for all tool calls.
interface ToolCallResult {
  success: boolean;    // Whether the operation succeeded
  data?: unknown;      // Result data (varies by tool)
  error?: string;      // Error message if success is false
}
```

---

### WALLET_TOOLS

Array of all built-in wallet tool definitions.

```typescript
// Import the complete array of all 8 wallet tool definitions.
// Use these to build custom AI integrations for providers not natively supported.
import { WALLET_TOOLS } from "@kova/wallet";
// ToolDefinition[] (8 tools)
```

### DANGEROUS_TOOLS

Array of the 2 dangerous tool definitions (`wallet_execute_custom` and `wallet_get_policy`) that must be explicitly opted into.

```typescript
// Import the dangerous tool definitions separately.
import { DANGEROUS_TOOLS } from "@kova/wallet";
// ToolDefinition[] (2 tools)
```

### ALL_WALLET_TOOLS

Combined array of all safe and dangerous tool definitions (same as `WALLET_TOOLS`).

```typescript
// Import the combined array of all tool definitions.
import { ALL_WALLET_TOOLS } from "@kova/wallet";
// ToolDefinition[] (8 tools)
```

### WRITE_TOOL_NAMES

Array of tool name strings for write operations only.

```typescript
// Import the array of write-only tool name strings.
// Useful for filtering or restricting agents to read-only operations.
import { WRITE_TOOL_NAMES } from "@kova/wallet";
// ["wallet_transfer", "wallet_swap", "wallet_mint", "wallet_stake", "wallet_execute_custom"]
```

### WALLET_TOOL_NAMES

Array of all tool name strings.

```typescript
// Import the array of all tool name strings.
// Useful for validation or filtering.
import { WALLET_TOOL_NAMES } from "@kova/wallet";
// ["wallet_transfer", "wallet_swap", "wallet_mint", "wallet_stake",
//  "wallet_execute_custom", "wallet_get_balance", "wallet_get_policy",
//  "wallet_get_transaction_history"]
```

### WalletToolName

Union type of all valid tool names.

```typescript
// Type-safe union of all valid tool names.
// Use this type to ensure your code only references valid tool names.
type WalletToolName =
  | "wallet_transfer"                 // Send tokens
  | "wallet_swap"                     // Swap tokens via DEX
  | "wallet_mint"                     // Mint an NFT
  | "wallet_stake"                    // Stake tokens with a validator
  | "wallet_execute_custom"           // Execute a custom program instruction
  | "wallet_get_balance"              // Query token balance
  | "wallet_get_policy"               // View policy constraints
  | "wallet_get_transaction_history"; // View recent transactions
```

### getToolByName

```typescript
// Look up a specific tool definition by its name.
// Returns undefined if the name doesn't match any known tool.
function getToolByName(name: WalletToolName): ToolDefinition | undefined
```

Retrieve a specific tool definition by name.

```typescript
// Import the lookup function.
import { getToolByName } from "@kova/wallet";

// Find the wallet_transfer tool definition by name.
// Returns the full ToolDefinition with name, description, and parameters.
const transferTool = getToolByName("wallet_transfer");
```

---

### Anthropic Adapter

#### `toAnthropicTools(): AnthropicTool[]`

Instance method on `AgentWallet`. Returns tools in Anthropic Messages API format.

```typescript
// Convert kova tools to Anthropic's format.
// The key transformation: "parameters" becomes "input_schema".
const tools = wallet.toAnthropicTools();
```

#### AnthropicTool

```typescript
// Anthropic's expected tool format for the Messages API.
interface AnthropicTool {
  name: string;              // Tool name (e.g., "wallet_transfer")
  description: string;       // Tool description for Claude
  input_schema: {            // JSON Schema for the tool's input (note: "input_schema", not "parameters")
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
// Convert kova tools to OpenAI's function calling format.
// Each tool is wrapped in { type: "function", function: { ... } }.
const tools = wallet.toOpenAITools();
```

#### OpenAITool

```typescript
// OpenAI's expected tool format for the Chat Completions API.
interface OpenAITool {
  type: "function";          // Always "function" -- tells OpenAI this is a callable function
  function: {
    name: string;            // Tool/function name
    description: string;     // Tool description for GPT
    parameters: {            // JSON Schema for the function's input parameters
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
// Import the LangChain adapter function.
// Unlike toAnthropicTools() and toOpenAITools(), this is a standalone function
// (not an instance method) because LangChain tools need a reference to the wallet.
import { createLangChainTools } from "@kova/wallet";

// Create LangChain-compatible tools from the wallet instance.
// Each tool includes a call() method that delegates to wallet.handleToolCall().
const tools = createLangChainTools(wallet);
```

#### LangChainToolDefinition

```typescript
// The LangChain-compatible tool format produced by createLangChainTools().
interface LangChainToolDefinition {
  name: string;                                          // Tool name
  description: string;                                   // Tool description for the LLM
  schema: Record<string, unknown>;                       // JSON Schema for input parameters
  call: (input: Record<string, unknown>) => Promise<string>; // The callable function (returns JSON string)
}
```

---

## Logging

### AuditLogger

Tamper-evident logger that creates a hash chain of audit entries. Each entry's hash depends on the previous entry, making it impossible to modify or delete entries without detection.

**Constructor (simple):**

```typescript
// Create an AuditLogger with default settings, passing a store directly.
new AuditLogger(store: Store)
```

**Constructor (with config):**

```typescript
// Create an AuditLogger with advanced configuration for failure handling.
new AuditLogger(config: AuditLoggerConfig)
```

#### AuditLoggerConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `store` | `Store` | Yes | Storage backend for audit entries |
| `maxConsecutiveFailures` | `number` | No | Max write failures before triggering callback |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback fired when failures exceed threshold |

```typescript
// Import AuditLogger from kova.
import { AuditLogger } from "@kova/wallet";

// Create an audit logger with failure monitoring.
// When audit writes fail 3 times in a row, the circuit breaker opens
// and blocks all transactions until the issue is resolved.
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,          // Open circuit after 3 consecutive failures
  onAuditFailure: (error) => {
    console.error("Audit failure:", error.message);  // Alert your ops team
  },
});
```

**Methods:**

#### `verifyIntegrity(count: number): Promise<IntegrityReport>`

Verify the integrity of the most recent N audit entries by recalculating and comparing hashes.

```typescript
// Walk the hash chain and verify that no entries have been tampered with.
// Pass the number of recent entries to check.
const report = await logger.verifyIntegrity(100);
console.log(report.valid);           // true if all hashes match
console.log(report.entriesChecked);  // number of entries verified
console.log(report.firstBrokenAt);  // undefined if valid, otherwise the index of the first broken entry
```

---

### AuditEntry

```typescript
// A single entry in the tamper-evident audit log.
// Each entry is linked to the previous one via the hash chain.
interface AuditEntry {
  id: string;                          // Unique entry ID
  timestamp: string;                   // ISO 8601 timestamp
  intentId: string;                    // The transaction intent ID
  intent: TransactionIntent;           // Deep clone of the full intent
  result: TransactionResult;           // The transaction result (confirmed, denied, etc.)
  policyAudits: PolicyRuleAudit[];     // Per-rule evaluation results
  hash: string;                        // SHA-256 hash of this entry (includes previousHash in computation)
  previousHash: string;                // Hash of the preceding entry (forms the chain)
}
```

---

### IntegrityReport

```typescript
// The result of verifying the audit log's hash chain integrity.
interface IntegrityReport {
  valid: boolean;                // Whether the entire chain is intact (no tampering detected)
  entriesChecked: number;        // Number of entries that were verified
  firstBrokenAt?: number;        // Index of first corrupted entry (undefined if valid)
}
```

---

### AuditCircuitOpenError

Error thrown when the audit logger's internal circuit breaker is open due to too many consecutive write failures.

```typescript
// Custom error class thrown when audit logging is unavailable.
// The AgentWallet catches this and blocks all transactions with a STORE_ERROR response.
class AuditCircuitOpenError extends Error {
  readonly consecutiveFailures: number;  // How many consecutive failures triggered the circuit
}
```

---

### AuditFailureCallback

```typescript
// Callback type for audit write failure notifications.
// Invoked each time a store.append() call fails when writing an audit entry.
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
// Configure the circuit breaker via the AgentWallet constructor.
// The breaker trips after maxConsecutiveFailures consecutive policy denials,
// stays open for resetTimeoutMs, then allows halfOpenMaxAttempts test transactions.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: {
    maxConsecutiveFailures: 5,    // Open after 5 consecutive denials
    resetTimeoutMs: 60000,        // Stay open for 60 seconds before trying again
    halfOpenMaxAttempts: 2,       // Allow 2 test transactions in half-open state
  },
});
```

**States:**

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation. Failure counter increments on each failure, resets on success. |
| **Open** | All transactions rejected with `CIRCUIT_BREAKER_OPEN`. Transitions to half-open after `resetTimeoutMs`. |
| **Half-Open** | Allows `halfOpenMaxAttempts` test transactions. Success closes the circuit; failure reopens it. |
