// ============================================================================
// kova — Public API
// A policy-constrained crypto wallet SDK for autonomous AI agents.
// ============================================================================

// Core
export { AgentWallet } from "./core/wallet.js";
export type { AgentWalletConfig } from "./core/wallet.js";
export type {
  TransactionIntent,
  IntentType,
  ChainId,
  IntentMetadata,
  IntentParams,
  TransferParams,
  SwapParams,
  MintParams,
  StakeParams,
  CustomParams,
} from "./core/intent.js";
export {
  isTransferIntent,
  isSwapIntent,
  isMintIntent,
  isStakeIntent,
  isCustomIntent,
} from "./core/intent.js";
export type {
  TransactionResult,
  TransactionStatus,
  TransactionError,
  TransactionErrorCode,
  TokenBalance,
  PolicySummary,
} from "./core/result.js";

// Policy
export { Policy } from "./policy/builder.js";
export { PolicyEngine } from "./policy/engine.js";
export type {
  PolicyConfig,
  PolicyRule,
  PolicyDecision,
  PolicyAllow,
  PolicyDeny,
  PolicyPending,
  PolicyContext,
  PolicyEvaluationResult,
  TokenAmount,
  SpendingLimitConfig,
  RateLimitConfig,
  ActiveHoursConfig,
  ApprovalGateConfig,
  TimeWindow,
} from "./policy/types.js";

// Policy Rules
export { SpendingLimitRule } from "./policy/rules/spending-limit.js";
export { AllowlistRule } from "./policy/rules/allowlist.js";
export { RateLimitRule } from "./policy/rules/rate-limit.js";
export { TimeWindowRule } from "./policy/rules/time-window.js";
export { ApprovalGateRule } from "./policy/rules/approval-gate.js";

// Signers
export type { Signer, UnsignedTransaction, SignedTransaction } from "./signers/interface.js";
export { LocalSigner } from "./signers/local.js";
export { MpcSigner, MpcSignerError } from "./signers/mpc.js";
export type { MpcSigningProvider, MpcSignerConfig, MpcSignResult, MpcSignerErrorCode } from "./signers/mpc.js";

// Stores
export type { Store } from "./stores/interface.js";
export { MemoryStore } from "./stores/memory.js";
export { SqliteStore } from "./stores/sqlite.js";

// Chain Adapters
export type { ChainAdapter, TransactionStatusResult, ChainTransactionStatus } from "./chains/interface.js";
export { SolanaAdapter } from "./chains/solana/adapter.js";

// Approval
export type { ApprovalChannel, ApprovalRequest, ApprovalResult, ApprovalDecision } from "./approval/interface.js";
export { TelegramApprovalBot } from "./approval/telegram.js";

// Core — Circuit Breaker (CRIT-04 fix: only export type, not class — prevents external reset() bypass)
export type { CircuitBreakerConfig } from "./core/circuit-breaker.js";

// Logging
export { AuditLogger, AuditCircuitOpenError } from "./logging/audit.js";
export type { AuditLoggerConfig, AuditFailureCallback, IntegrityReport } from "./logging/audit.js";
export type { AuditEntry, PolicyRuleAudit } from "./logging/types.js";

// Adapters
export type { ToolDefinition, ToolParameter, ToolCallResult } from "./adapters/types.js";
export { WALLET_TOOLS, WALLET_TOOL_NAMES, getToolByName } from "./adapters/tools.js";
export type { WalletToolName } from "./adapters/tools.js";
export { toAnthropicTools } from "./adapters/claude.js";
export type { AnthropicTool } from "./adapters/claude.js";
export { toOpenAITools } from "./adapters/openai.js";
export type { OpenAITool } from "./adapters/openai.js";
export { createLangChainTools } from "./adapters/langchain.js";
export type { LangChainToolDefinition } from "./adapters/langchain.js";
