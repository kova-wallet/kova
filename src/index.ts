// ============================================================================
// kova — Public API
// A policy-constrained crypto wallet SDK for autonomous AI agents.
//
// NOTE: tsconfig.json has skipLibCheck enabled for build performance.
// This means type errors in third-party .d.ts files will not be caught
// at compile time. If you encounter runtime type mismatches with
// dependencies, consider running tsc with --skipLibCheck false to diagnose.
// (See SUPPLY-012)
//
// SUPPLY-011: PUBLIC API SURFACE — This barrel export file defines the SDK's
// public API. Internal modules marked with @internal JSDoc tags are exported
// for advanced use cases (testing, custom audit pipelines) but are not part
// of the stable API contract. Breaking changes to @internal exports may occur
// in minor versions. Consumers should prefer the Policy builder and
// AgentWallet class for standard usage.
// ============================================================================

// ---------------------------------------------------------------------------
// Core — Public API
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Policy — Public API (builder interface)
// ---------------------------------------------------------------------------
export { Policy } from "./policy/builder.js";
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
  UsdSpendingLimit,
  RateLimitConfig,
  ActiveHoursConfig,
  ApprovalGateConfig,
  TimeWindow,
} from "./policy/types.js";

// ---------------------------------------------------------------------------
// Policy Engine & Rules — Internal
// These are exported for advanced use cases and testing, but most consumers
// should use the Policy builder above instead of instantiating rules directly.
// ---------------------------------------------------------------------------
/** @internal — Use {@link Policy} builder instead of constructing directly. */
export { PolicyEngine } from "./policy/engine.js";
/** @internal — Use {@link Policy.spendingLimit} instead. */
export { SpendingLimitRule } from "./policy/rules/spending-limit.js";
/** @internal — Use {@link Policy.allowlist} instead. */
export { AllowlistRule } from "./policy/rules/allowlist.js";
/** @internal — Use {@link Policy.rateLimit} instead. */
export { RateLimitRule } from "./policy/rules/rate-limit.js";
/** @internal — Use {@link Policy.timeWindow} instead. */
export { TimeWindowRule } from "./policy/rules/time-window.js";
/** @internal — Use {@link Policy.approvalGate} instead. */
export { ApprovalGateRule } from "./policy/rules/approval-gate.js";

// ---------------------------------------------------------------------------
// Signers — Public API
// ---------------------------------------------------------------------------
export type { Signer, UnsignedTransaction, SignedTransaction } from "./signers/interface.js";
export { LocalSigner } from "./signers/local.js";
export { MpcSigner, MpcSignerError } from "./signers/mpc.js";
export type { MpcSigningProvider, MpcSignerConfig, MpcSignResult, MpcSignerErrorCode } from "./signers/mpc.js";

// ---------------------------------------------------------------------------
// Stores — Public API
// ---------------------------------------------------------------------------
export type { Store } from "./stores/interface.js";
export { MemoryStore } from "./stores/memory.js";
export { SqliteStore } from "./stores/sqlite.js";
/** @internal — Used by AgentWallet to namespace store keys; not for direct use. */
export { PrefixedStore } from "./stores/prefixed.js";

// ---------------------------------------------------------------------------
// Chain Adapters — Public API
// ---------------------------------------------------------------------------
export type { ChainAdapter, TransactionStatusResult, ChainTransactionStatus, SimulationResult } from "./chains/interface.js";
export { SolanaAdapter } from "./chains/solana/adapter.js";

// ---------------------------------------------------------------------------
// Approval — Public API
// ---------------------------------------------------------------------------
export type { ApprovalChannel, ApprovalRequest, ApprovalResult, ApprovalDecision } from "./approval/interface.js";
export { TelegramApprovalBot } from "./approval/telegram.js";

// ---------------------------------------------------------------------------
// Circuit Breaker — Internal
// (CRIT-04 fix: only export type, not class — prevents external reset() bypass)
// ---------------------------------------------------------------------------
/** @internal */
export type { CircuitBreakerConfig } from "./core/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Logging — Internal
// Audit logging is managed internally by AgentWallet. These exports exist
// for advanced diagnostics and custom audit pipelines.
// ---------------------------------------------------------------------------
/** @internal */
export { AuditLogger, AuditCircuitOpenError } from "./logging/audit.js";
/** @internal */
export type { AuditLoggerConfig, AuditFailureCallback, IntegrityReport } from "./logging/audit.js";
/** @internal */
export type { AuditEntry, PolicyRuleAudit } from "./logging/types.js";

// ---------------------------------------------------------------------------
// LLM Adapters — Public API
// Tool definitions and framework-specific adapters for AI agent integration.
// ---------------------------------------------------------------------------
export type { ToolDefinition, ToolParameter, ToolCallResult } from "./adapters/types.js";
export { WALLET_TOOLS, WALLET_TOOL_NAMES, getToolByName } from "./adapters/tools.js";
export type { WalletToolName } from "./adapters/tools.js";
export { toAnthropicTools } from "./adapters/claude.js";
export type { AnthropicTool } from "./adapters/claude.js";
export { toOpenAITools } from "./adapters/openai.js";
export type { OpenAITool } from "./adapters/openai.js";
export { createLangChainTools } from "./adapters/langchain.js";
export type { LangChainToolDefinition } from "./adapters/langchain.js";
