/**
 * AgentWallet — The main entry point for the SDK.
 * Wires together the policy engine, signer, chain adapter, and store.
 *
 * Data flow: intent → validate → normalize → audit check → circuit breaker → policy evaluation → build tx → sign → broadcast → log → result
 *
 * S6 enhancements:
 * - PolicyEngine now returns PolicyEvaluationResult with per-rule audit data
 * - Circuit breaker blocks transactions after N consecutive denials
 * - Audit circuit breaker blocks transactions when audit logging is broken
 * - logAudit() uses real per-rule audit data from engine (S1-12 fix)
 */

import { randomUUID } from "node:crypto";
import { isTransferIntent, isSwapIntent, isMintIntent, isStakeIntent, isCustomIntent } from "./intent.js";
import type { TransactionIntent } from "./intent.js";
import type { TokenBalance, TransactionResult, TransactionError, PolicySummary } from "./result.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { Signer } from "../signers/interface.js";
import type { Store } from "../stores/interface.js";
import type { ChainAdapter } from "../chains/interface.js";
import type { ApprovalChannel } from "../approval/interface.js";
import { AuditLogger, AuditCircuitOpenError } from "../logging/audit.js";
import type { AuditFailureCallback } from "../logging/audit.js";
import type { AuditEntry } from "../logging/types.js";
import type { PolicyRuleAudit } from "../policy/types.js";
import type { ToolCallResult } from "../adapters/types.js";
import { toAnthropicTools as convertToAnthropicTools, type AnthropicTool } from "../adapters/claude.js";
import { toOpenAITools as convertToOpenAITools, type OpenAITool } from "../adapters/openai.js";
import { WALLET_TOOL_NAMES, type WalletToolName } from "../adapters/tools.js";
import { SpendingLimitRule } from "../policy/rules/spending-limit.js";
import { AllowlistRule } from "../policy/rules/allowlist.js";
import { RateLimitRule } from "../policy/rules/rate-limit.js";
import { TimeWindowRule } from "../policy/rules/time-window.js";
import { ApprovalGateRule } from "../policy/rules/approval-gate.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import type { ChainId } from "./intent.js";

/** Maximum number of history entries that can be requested */
const MAX_HISTORY_LIMIT = 1000;

/** TTL for idempotency keys (24 hours) */
const IDEMPOTENCY_TTL = 86_400;

/** Store key prefix for idempotency */
const IDEMPOTENCY_PREFIX = "idempotency:";

/** Valid chain IDs */
const VALID_CHAINS = new Set(["solana", "ethereum", "base"]);

/** Valid intent types */
const VALID_TYPES = new Set(["transfer", "swap", "mint", "stake", "custom"]);

/** HIGH-10 fix: Maximum length limits for string inputs to prevent memory exhaustion */
const MAX_ADDRESS_LENGTH = 128;
const MAX_TOKEN_LENGTH = 64;
const MAX_DATA_LENGTH = 65_536; // SEC: 64KB (reduced from 1MB to limit audit log entry size)
const MAX_URI_LENGTH = 2048;
const MAX_REASON_LENGTH = 1024;
const MAX_AMOUNT_LENGTH = 64;
const MAX_AMOUNT_DECIMALS = 18; // SEC: supports EVM-style 18 decimals, safe for Solana (<= 9)
const MAX_METADATA_ID_LENGTH = 128;
/** SEC: Maximum accounts per custom intent to prevent oversized audit entries */
const MAX_ACCOUNTS = 64;
/** SEC: Prevent JSON.parse memory DoS on tool-provided accounts blobs */
const MAX_ACCOUNTS_JSON_LENGTH = 65_536; // 64KB

const DECIMAL_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

function validateDecimalAmount(value: string): string | null {
  if (value.length > MAX_AMOUNT_LENGTH) return `'amount' exceeds max length of ${MAX_AMOUNT_LENGTH}`;
  if (value.trim() !== value) return "'amount' must not include leading or trailing whitespace";
  if (!DECIMAL_AMOUNT_REGEX.test(value)) {
    return `invalid amount '${value}'. Must be a positive decimal string`;
  }
  const fractional = value.split(".")[1];
  if (fractional && fractional.length > MAX_AMOUNT_DECIMALS) {
    return `'amount' has more than ${MAX_AMOUNT_DECIMALS} decimal places`;
  }
  const parsed = parseFloat(value);
  if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
    return `invalid amount '${value}'. Must be a finite positive number`;
  }
  return null;
}

export interface AgentWalletConfig {
  /** The signer responsible for signing transactions */
  signer: Signer;
  /** The chain adapter for blockchain interactions */
  chain: ChainAdapter;
  /** The policy engine for evaluating transaction intents */
  policy: PolicyEngine;
  /** The store for persisting spending counters and tx logs */
  store: Store;
  /** Optional approval channel for human-in-the-loop */
  approval?: ApprovalChannel;
  /** Optional audit logger. If not provided, one is created using the store. */
  logger?: AuditLogger;
  /**
   * Circuit breaker configuration. Set to `false` to disable.
   * Default: enabled with threshold=5, cooldownMs=300000 (5 min)
   */
  circuitBreaker?: Partial<CircuitBreakerConfig> | false;
  /** Callback invoked when an audit log write fails */
  onAuditFailure?: AuditFailureCallback;
}

export class AgentWallet {
  private readonly signer: Signer;
  private readonly chain: ChainAdapter;
  private readonly policy: PolicyEngine;
  private readonly store: Store;
  private readonly approval?: ApprovalChannel;
  private readonly logger: AuditLogger;
  private readonly circuitBreaker?: CircuitBreaker;
  /** S1-04 fix: mutex to serialize execute() calls and prevent concurrent policy bypass */
  private executeLock: Promise<void> = Promise.resolve();

  constructor(config: AgentWalletConfig) {
    this.signer = config.signer;
    this.chain = config.chain;
    this.policy = config.policy;
    this.store = config.store;
    this.approval = config.approval;

    // Create AuditLogger — use provided logger, or create one with config
    if (config.logger) {
      this.logger = config.logger;
    } else if (config.onAuditFailure) {
      this.logger = new AuditLogger({
        store: config.store,
        onAuditFailure: config.onAuditFailure,
      });
    } else {
      this.logger = new AuditLogger(config.store);
    }

    // Create CircuitBreaker unless disabled
    if (config.circuitBreaker !== false) {
      this.circuitBreaker = new CircuitBreaker(config.store, config.circuitBreaker ?? undefined);
    }
  }

  /**
   * Execute a transaction intent.
   * Full pipeline: validate → normalize → audit check → circuit breaker → policy → build → sign → broadcast → log → result
   *
   * S1-04 fix: Serialized via mutex to prevent concurrent policy bypass.
   * S1-02 fix: Idempotent — duplicate intent IDs return cached results.
   * S1-09 fix: Validates intent structure before processing.
   */
  async execute(intent: TransactionIntent): Promise<TransactionResult> {
    // S1-09 fix: Validate intent structure before any processing
    const validationError = this.validateIntent(intent);
    if (validationError) {
      return {
        status: "failed",
        summary: `Validation failed: ${validationError}`,
        intentId: intent.id ?? "unknown",
        timestamp: Date.now(),
        error: {
          code: "VALIDATION_FAILED",
          message: validationError,
        },
      };
    }

    // S1-04 fix: Serialize execute() calls to prevent TOCTOU races
    let releaseLock: () => void;
    const previousLock = this.executeLock;
    this.executeLock = new Promise<void>((resolve) => { releaseLock = resolve; });

    await previousLock;

    try {
      return await this.executeInternal(intent);
    } finally {
      releaseLock!();
    }
  }

  /** Internal execute after validation and mutex acquisition */
  private async executeInternal(intent: TransactionIntent): Promise<TransactionResult> {
    // 1. Normalize the intent (assign ID, timestamp)
    const normalizedIntent = this.normalizeIntent(intent);
    const intentId = normalizedIntent.id!;

    // S1-02 fix: Check for duplicate intent ID
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${intentId}`;
    const cachedResult = await this.store.get(idempotencyKey);
    if (cachedResult !== null) {
      try {
        // S2-16 fix: Validate parsed cache entry before returning
        const parsed = JSON.parse(cachedResult);
        if (parsed && typeof parsed.status === "string" && typeof parsed.intentId === "string") {
          return parsed as TransactionResult;
        }
        // Invalid cache schema — proceed with fresh execution
      } catch {
        // Corrupted cache entry — proceed with execution
      }
    }

    // S6: Check if audit logging is broken — refuse transactions when audit is down
    if (this.logger.isCircuitOpen()) {
      return {
        status: "failed",
        summary: "Transaction blocked: audit logging is unavailable",
        intentId,
        timestamp: Date.now(),
        error: {
          code: "STORE_ERROR",
          message: "Audit logging circuit breaker is open. Transactions are blocked until audit logging is restored.",
        },
      };
    }

    // S6: Check circuit breaker — refuse transactions during cooldown after consecutive denials
    if (this.circuitBreaker) {
      const cbReason = await this.circuitBreaker.check();
      if (cbReason) {
        return {
          status: "denied",
          summary: `Denied by circuit breaker: ${cbReason}`,
          intentId,
          timestamp: Date.now(),
          error: {
            code: "CIRCUIT_BREAKER_OPEN",
            message: cbReason,
          },
        };
      }
    }

    // 2. Evaluate the policy — now returns PolicyEvaluationResult with per-rule audits
    const evaluationResult = await this.policy.evaluate(normalizedIntent);
    const policyDecision = evaluationResult.decision;
    const ruleAudits = evaluationResult.ruleAudits;

    // S6: Record outcome for circuit breaker
    if (this.circuitBreaker) {
      await this.circuitBreaker.recordOutcome(policyDecision.decision);
    }

    // 3. If denied, return immediately with error
    if (policyDecision.decision === "DENY") {
      const error: TransactionError = {
        code: "POLICY_DENIED",
        message: policyDecision.reason,
        policyRule: policyDecision.rule,
      };

      const result: TransactionResult = {
        status: "denied",
        summary: `Denied by policy: ${error.message}`,
        intentId,
        timestamp: Date.now(),
        error,
      };

      await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
      // S2-03 fix: Don't cache denied results — denial may be temporary (rate limit expires, budget resets)
      return result;
    }

    // 4. If pending (approval required), return pending status
    if (policyDecision.decision === "PENDING") {
      const result: TransactionResult = {
        status: "pending",
        summary: `Awaiting human approval (request: ${policyDecision.approvalRequestId})`,
        intentId,
        timestamp: Date.now(),
      };

      await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
      // S2-03 fix: Don't cache pending results — approval may arrive on retry
      return result;
    }

    // 5. Build, sign, and broadcast the transaction
    try {
      const signerAddress = await this.signer.getAddress();

      // Build unsigned transaction
      const unsignedTx = await this.chain.buildTransaction(normalizedIntent, signerAddress);

      // Sign it
      const signedTx = await this.signer.sign(unsignedTx);

      // Broadcast to chain
      const txId = await this.chain.broadcast(signedTx.data);

      const result: TransactionResult = {
        status: "confirmed",
        txId,
        summary: this.buildSummary(normalizedIntent),
        intentId,
        timestamp: Date.now(),
      };

      await this.logAudit(normalizedIntent, ruleAudits, policyDecision, { txId, status: "confirmed" });
      await this.cacheResult(idempotencyKey, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      const error: TransactionError = {
        code: "TRANSACTION_FAILED",
        message,
      };

      const result: TransactionResult = {
        status: "failed",
        summary: `Transaction failed: ${message}`,
        intentId,
        timestamp: Date.now(),
        error,
      };

      await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
      await this.cacheResult(idempotencyKey, result);
      return result;
    }
  }

  /**
   * Get the wallet's balance for a specific token.
   */
  async getBalance(token: string): Promise<TokenBalance> {
    const address = await this.signer.getAddress();
    return this.chain.getBalance(address, token);
  }

  /**
   * Get the wallet's address.
   */
  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  /**
   * Get a read-only summary of the current policy constraints.
   * Agents can use this to plan within their limits.
   */
  async getPolicy(): Promise<PolicySummary> {
    const rules = this.policy.getRules();
    const summary: PolicySummary = {
      name: this.policy.getRuleNames().join("+") || "default",
      spendingLimits: {},
      allowlistedAddresses: 0,
      allowlistedPrograms: 0,
    };

    for (const rule of rules) {
      if (rule instanceof SpendingLimitRule) {
        this.populateSpendingLimits(summary, rule);
      } else if (rule instanceof AllowlistRule) {
        this.populateAllowlist(summary, rule);
      } else if (rule instanceof RateLimitRule) {
        this.populateRateLimits(summary, rule);
      } else if (rule instanceof TimeWindowRule) {
        this.populateTimeWindow(summary, rule);
      } else if (rule instanceof ApprovalGateRule) {
        this.populateApprovalGate(summary, rule);
      }
    }

    // S6: Populate circuit breaker status
    if (this.circuitBreaker) {
      const cbConfig = this.circuitBreaker.getConfig();
      const cbCheck = await this.circuitBreaker.check();
      summary.circuitBreaker = {
        threshold: cbConfig.threshold,
        cooldownMs: cbConfig.cooldownMs,
        isOpen: cbCheck !== null,
      };
    }

    return summary;
  }

  /**
   * Get recent transaction history from the audit log.
   * S1-06 fix: limit is validated and clamped to [1, MAX_HISTORY_LIMIT].
   */
  async getTransactionHistory(limit: number = 10): Promise<TransactionResult[]> {
    if (!Number.isFinite(limit) || limit < 1) {
      limit = 10;
    }
    const sanitizedLimit = Math.min(Math.floor(limit), MAX_HISTORY_LIMIT);
    const entries = await this.logger.getRecent(sanitizedLimit);
    return entries.map((entry) => ({
      status: this.mapAuditStatus(entry),
      txId: entry.transactionResult?.txId,
      summary: this.buildSummary(entry.intent),
      intentId: entry.intentId,
      timestamp: entry.timestamp,
    }));
  }

  /**
   * Handle a tool call from an AI agent.
   * Dispatches to the appropriate wallet method based on tool name.
   */
  async handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      switch (name as WalletToolName) {
        case "wallet_transfer":
          return await this.handleTransfer(input);
        case "wallet_swap":
          return await this.handleSwap(input);
        case "wallet_mint":
          return await this.handleMint(input);
        case "wallet_stake":
          return await this.handleStake(input);
        case "wallet_execute_custom":
          return await this.handleCustom(input);
        case "wallet_get_balance":
          return await this.handleGetBalance(input);
        case "wallet_get_policy":
          return await this.handleGetPolicy();
        case "wallet_get_transaction_history":
          return await this.handleGetHistory(input);
        default:
          return {
            success: false,
            error: `Unknown tool: ${name}. Available tools: ${WALLET_TOOL_NAMES.join(", ")}`,
          };
      }
    } catch {
      // S5-04 fix: sanitize error — do not leak internal details back to the agent
      return {
        success: false,
        error: "An internal error occurred while processing the tool call.",
      };
    }
  }

  /**
   * Get tool definitions in Anthropic (Claude) format.
   */
  toAnthropicTools(): AnthropicTool[] {
    return convertToAnthropicTools();
  }

  /**
   * Get tool definitions in OpenAI format.
   */
  toOpenAITools(): OpenAITool[] {
    return convertToOpenAITools();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * S1-09 fix: Validate intent structure before processing.
   * Returns an error message if invalid, or null if valid.
   */
  private validateIntent(intent: TransactionIntent): string | null {
    if (!intent || typeof intent !== "object") {
      return "Intent must be a non-null object";
    }

    if (!VALID_TYPES.has(intent.type)) {
      return `Invalid intent type: ${String(intent.type)}. Must be one of: transfer, swap, mint, stake, custom`;
    }

    if (!VALID_CHAINS.has(intent.chain)) {
      return `Invalid chain: ${String(intent.chain)}. Must be one of: solana, ethereum, base`;
    }

    // SEC: Verify intent chain matches the configured adapter to prevent
    // cross-chain confusion (e.g., intent labeled "ethereum" executed by SolanaAdapter)
    if (intent.chain !== this.chain.chain) {
      return `Chain mismatch: intent targets "${intent.chain}" but wallet is configured for "${this.chain.chain}"`;
    }

    if (!intent.params || typeof intent.params !== "object") {
      return "Intent params must be a non-null object";
    }

	    // S2-15 fix: Validate intent ID format if provided
	    if (intent.id !== undefined) {
	      if (typeof intent.id !== "string" || intent.id.length === 0 || intent.id.length > 128) {
	        return "Intent ID must be a string between 1 and 128 characters";
	      }
	    }

	    if (intent.createdAt !== undefined) {
	      if (typeof intent.createdAt !== "number" || !Number.isFinite(intent.createdAt) || intent.createdAt < 0) {
	        return "Intent createdAt must be a finite non-negative number (milliseconds since epoch)";
	      }
	    }

	    if (intent.metadata !== undefined) {
	      if (!intent.metadata || typeof intent.metadata !== "object" || Array.isArray(intent.metadata)) {
	        return "Intent metadata must be an object";
	      }

	      const metadata = intent.metadata as Record<string, unknown>;
	      if (metadata.reason !== undefined) {
	        if (typeof metadata.reason !== "string") return "Metadata 'reason' must be a string";
	        if (metadata.reason.length > MAX_REASON_LENGTH) {
	          return `Metadata reason exceeds maximum length of ${MAX_REASON_LENGTH} characters`;
	        }
	      }
	      if (metadata.agentId !== undefined) {
	        if (typeof metadata.agentId !== "string" || metadata.agentId.trim() === "") {
	          return "Metadata 'agentId' must be a non-empty string";
	        }
	        if (metadata.agentId.length > MAX_METADATA_ID_LENGTH) {
	          return `Metadata 'agentId' exceeds max length of ${MAX_METADATA_ID_LENGTH}`;
	        }
	      }
	      if (metadata.taskId !== undefined) {
	        if (typeof metadata.taskId !== "string" || metadata.taskId.trim() === "") {
	          return "Metadata 'taskId' must be a non-empty string";
	        }
	        if (metadata.taskId.length > MAX_METADATA_ID_LENGTH) {
	          return `Metadata 'taskId' exceeds max length of ${MAX_METADATA_ID_LENGTH}`;
	        }
	      }
	      if (metadata.urgency !== undefined) {
	        if (metadata.urgency !== "low" && metadata.urgency !== "normal" && metadata.urgency !== "high") {
	          return "Metadata 'urgency' must be one of: low, normal, high";
	        }
	      }
	    }

	    // Type-specific validation with HIGH-10 max length checks
	    if (isTransferIntent(intent)) {
	      const { to, amount, token } = intent.params;
	      if (typeof to !== "string" || to.trim() === "") return "Transfer: 'to' must be a non-empty string";
	      if (to.length > MAX_ADDRESS_LENGTH) return `Transfer: 'to' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	      if (to.trim() !== to) return "Transfer: 'to' must not include leading or trailing whitespace";
	      try {
	        if (!this.chain.isValidAddress(to)) return `Transfer: 'to' is not a valid ${this.chain.chain} address`;
	      } catch {
	        return `Transfer: failed to validate recipient address for chain "${this.chain.chain}"`;
	      }

	      if (typeof amount !== "string" || amount.trim() === "") return "Transfer: 'amount' must be a non-empty string";
	      const amountErr = validateDecimalAmount(amount);
	      if (amountErr) return `Transfer: ${amountErr}`;

	      if (typeof token !== "string" || token.trim() === "") return "Transfer: 'token' must be a non-empty string";
	      if (token.trim() !== token) return "Transfer: 'token' must not include leading or trailing whitespace";
	      if (token.length > MAX_TOKEN_LENGTH) return `Transfer: 'token' exceeds max length of ${MAX_TOKEN_LENGTH}`;
	    }

	    if (isSwapIntent(intent)) {
	      const { fromToken, toToken, amount, maxSlippage } = intent.params;
	      if (typeof fromToken !== "string" || fromToken.trim() === "") return "Swap: 'fromToken' must be a non-empty string";
	      if (fromToken.trim() !== fromToken) return "Swap: 'fromToken' must not include leading or trailing whitespace";
	      if (fromToken.length > MAX_TOKEN_LENGTH) return `Swap: 'fromToken' exceeds max length of ${MAX_TOKEN_LENGTH}`;
	      if (typeof toToken !== "string" || toToken.trim() === "") return "Swap: 'toToken' must be a non-empty string";
	      if (toToken.trim() !== toToken) return "Swap: 'toToken' must not include leading or trailing whitespace";
	      if (toToken.length > MAX_TOKEN_LENGTH) return `Swap: 'toToken' exceeds max length of ${MAX_TOKEN_LENGTH}`;
	      if (typeof amount !== "string" || amount.trim() === "") return "Swap: 'amount' must be a non-empty string";
	      const amountErr = validateDecimalAmount(amount);
	      if (amountErr) return `Swap: ${amountErr}`;
	      if (maxSlippage !== undefined) {
	        if (typeof maxSlippage !== "number" || !Number.isFinite(maxSlippage) || maxSlippage < 0 || maxSlippage > 1) {
	          return "Swap: 'maxSlippage' must be a finite number between 0 and 1";
	        }
	      }
	    }

	    if (isMintIntent(intent)) {
	      const { collection, metadataUri, to } = intent.params;
	      if (typeof collection !== "string" || collection.trim() === "") return "Mint: 'collection' must be a non-empty string";
	      if (collection.length > MAX_ADDRESS_LENGTH) return `Mint: 'collection' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	      if (collection.trim() !== collection) return "Mint: 'collection' must not include leading or trailing whitespace";
	      try {
	        if (!this.chain.isValidAddress(collection)) return `Mint: 'collection' is not a valid ${this.chain.chain} address`;
	      } catch {
	        return `Mint: failed to validate collection address for chain "${this.chain.chain}"`;
	      }
	      if (typeof metadataUri !== "string" || metadataUri.trim() === "") return "Mint: 'metadataUri' must be a non-empty string";
	      if (metadataUri.trim() !== metadataUri) return "Mint: 'metadataUri' must not include leading or trailing whitespace";
	      if (metadataUri.length > MAX_URI_LENGTH) return `Mint: 'metadataUri' exceeds max length of ${MAX_URI_LENGTH}`;
	      if (to !== undefined) {
	        if (typeof to !== "string" || to.trim() === "") return "Mint: 'to' must be a non-empty string";
	        if (to.length > MAX_ADDRESS_LENGTH) return `Mint: 'to' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	        if (to.trim() !== to) return "Mint: 'to' must not include leading or trailing whitespace";
	        try {
	          if (!this.chain.isValidAddress(to)) return `Mint: 'to' is not a valid ${this.chain.chain} address`;
	        } catch {
	          return `Mint: failed to validate recipient address for chain "${this.chain.chain}"`;
	        }
	      }
	    }

	    if (isStakeIntent(intent)) {
	      const { amount, token, validator } = intent.params;
	      if (typeof amount !== "string" || amount.trim() === "") return "Stake: 'amount' must be a non-empty string";
	      const amountErr = validateDecimalAmount(amount);
	      if (amountErr) return `Stake: ${amountErr}`;
	      if (typeof token !== "string" || token.trim() === "") return "Stake: 'token' must be a non-empty string";
	      if (token.trim() !== token) return "Stake: 'token' must not include leading or trailing whitespace";
	      if (token.length > MAX_TOKEN_LENGTH) return `Stake: 'token' exceeds max length of ${MAX_TOKEN_LENGTH}`;
	      if (validator !== undefined) {
	        if (typeof validator !== "string" || validator.trim() === "") return "Stake: 'validator' must be a non-empty string";
	        if (validator.length > MAX_ADDRESS_LENGTH) return `Stake: 'validator' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	        if (validator.trim() !== validator) return "Stake: 'validator' must not include leading or trailing whitespace";
	        try {
	          if (!this.chain.isValidAddress(validator)) return `Stake: 'validator' is not a valid ${this.chain.chain} address`;
	        } catch {
	          return `Stake: failed to validate validator address for chain "${this.chain.chain}"`;
	        }
	      }
	    }

	    if (isCustomIntent(intent)) {
	      const { programId, data, accounts } = intent.params;
	      if (typeof programId !== "string" || programId.trim() === "") return "Custom: 'programId' must be a non-empty string";
	      if (programId.length > MAX_ADDRESS_LENGTH) return `Custom: 'programId' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	      if (programId.trim() !== programId) return "Custom: 'programId' must not include leading or trailing whitespace";
	      try {
	        if (!this.chain.isValidAddress(programId)) return `Custom: 'programId' is not a valid ${this.chain.chain} address`;
	      } catch {
	        return `Custom: failed to validate programId for chain "${this.chain.chain}"`;
	      }
	      if (typeof data !== "string") return "Custom: 'data' must be a string";
	      if (data.trim() !== data) return "Custom: 'data' must not include leading or trailing whitespace";
	      if (data.length > MAX_DATA_LENGTH) return `Custom: 'data' exceeds max length of ${MAX_DATA_LENGTH}`;
	      if (!Array.isArray(accounts)) return "Custom: 'accounts' must be an array";
	      if (accounts.length > MAX_ACCOUNTS) return `Custom: 'accounts' exceeds max count of ${MAX_ACCOUNTS}`;
	      for (const account of accounts) {
	        if (
	          !account ||
	          typeof account !== "object" ||
	          typeof (account as { address?: unknown }).address !== "string" ||
	          typeof (account as { isSigner?: unknown }).isSigner !== "boolean" ||
	          typeof (account as { isWritable?: unknown }).isWritable !== "boolean"
	        ) {
	          return "Custom: each account must have { address: string, isSigner: boolean, isWritable: boolean }";
	        }
	        const address = (account as { address: string }).address;
	        if (address.trim() === "") return "Custom: account 'address' must be a non-empty string";
	        if (address.length > MAX_ADDRESS_LENGTH) return `Custom: account 'address' exceeds max length of ${MAX_ADDRESS_LENGTH}`;
	        if (address.trim() !== address) return "Custom: account 'address' must not include leading or trailing whitespace";
	        try {
	          if (!this.chain.isValidAddress(address)) return `Custom: account 'address' is not a valid ${this.chain.chain} address`;
	        } catch {
	          return `Custom: failed to validate account address for chain "${this.chain.chain}"`;
	        }
	      }
	    }

    return null;
  }

  /** S1-02 fix: Cache a result for idempotency */
  private async cacheResult(key: string, result: TransactionResult): Promise<void> {
    try {
      await this.store.set(key, JSON.stringify(result), IDEMPOTENCY_TTL);
    } catch {
      // Cache failure must not break the transaction flow
    }
  }

  /** Assign ID and timestamp if not already set */
  private normalizeIntent(intent: TransactionIntent): TransactionIntent {
    return {
      ...intent,
      id: intent.id ?? randomUUID(),
      createdAt: intent.createdAt ?? Date.now(),
    };
  }

  /** Build a human-readable summary from an intent */
  private buildSummary(intent: TransactionIntent): string {
    if (isTransferIntent(intent)) {
      const { to, amount, token } = intent.params;
      const shortAddr = to.length > 8 ? `${to.slice(0, 4)}...${to.slice(-4)}` : to;
      return `Sent ${amount} ${token} to ${shortAddr}`;
    }

    if (isSwapIntent(intent)) {
      const { fromToken, toToken, amount } = intent.params;
      return `Swapped ${amount} ${fromToken} for ${toToken}`;
    }

    if (isMintIntent(intent)) {
      return `Minted NFT from collection ${intent.params.collection.slice(0, 8)}...`;
    }

    if (isStakeIntent(intent)) {
      const { amount, token } = intent.params;
      return `Staked ${amount} ${token}`;
    }

    return `Executed ${intent.type} on ${intent.chain}`;
  }

  /**
   * Map audit entry state to TransactionStatus.
   * S1-14 fix: explicit handling for each known state.
   */
	  private mapAuditStatus(entry: AuditEntry): TransactionResult["status"] {
	    if (entry.transactionResult?.status === "confirmed") return "confirmed";
	    if (entry.transactionResult?.status === "failed") return "failed";
	    if (entry.finalDecision.decision === "DENY") return "denied";
	    if (entry.finalDecision.decision === "PENDING") return "pending";
	    // ALLOW with no transaction result means execution threw
	    return "failed";
	  }

	  private sanitizeMetadataForAudit(metadata: unknown): TransactionIntent["metadata"] | undefined {
	    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	    const raw = metadata as Record<string, unknown>;
	    const sanitized: Record<string, unknown> = {};

	    if (typeof raw.reason === "string") sanitized.reason = raw.reason.slice(0, MAX_REASON_LENGTH);
	    if (typeof raw.agentId === "string") sanitized.agentId = raw.agentId.slice(0, MAX_METADATA_ID_LENGTH);
	    if (typeof raw.taskId === "string") sanitized.taskId = raw.taskId.slice(0, MAX_METADATA_ID_LENGTH);
	    if (raw.urgency === "low" || raw.urgency === "normal" || raw.urgency === "high") sanitized.urgency = raw.urgency;

	    return Object.keys(sanitized).length > 0 ? (sanitized as TransactionIntent["metadata"]) : undefined;
	  }

	  private sanitizeIntentForAudit(intent: TransactionIntent): TransactionIntent {
	    const id = typeof intent.id === "string" ? intent.id.slice(0, 128) : undefined;
	    const createdAt =
	      typeof intent.createdAt === "number" && Number.isFinite(intent.createdAt) && intent.createdAt >= 0
	        ? intent.createdAt
	        : undefined;
	    const metadata = this.sanitizeMetadataForAudit(intent.metadata);

	    const common = {
	      ...(id ? { id } : {}),
	      type: intent.type,
	      chain: intent.chain,
	      ...(createdAt !== undefined ? { createdAt } : {}),
	      ...(metadata ? { metadata } : {}),
	    } as const;

	    if (isTransferIntent(intent)) {
	      const { to, amount, token } = intent.params;
	      return {
	        ...common,
	        params: {
	          to: to.slice(0, MAX_ADDRESS_LENGTH),
	          amount: amount.slice(0, MAX_AMOUNT_LENGTH),
	          token: token.slice(0, MAX_TOKEN_LENGTH),
	        },
	      };
	    }

	    if (isSwapIntent(intent)) {
	      const { fromToken, toToken, amount, maxSlippage } = intent.params;
	      return {
	        ...common,
	        params: {
	          fromToken: fromToken.slice(0, MAX_TOKEN_LENGTH),
	          toToken: toToken.slice(0, MAX_TOKEN_LENGTH),
	          amount: amount.slice(0, MAX_AMOUNT_LENGTH),
	          ...(typeof maxSlippage === "number" && Number.isFinite(maxSlippage) ? { maxSlippage } : {}),
	        },
	      };
	    }

	    if (isMintIntent(intent)) {
	      const { collection, metadataUri, to } = intent.params;
	      return {
	        ...common,
	        params: {
	          collection: collection.slice(0, MAX_ADDRESS_LENGTH),
	          metadataUri: metadataUri.slice(0, MAX_URI_LENGTH),
	          ...(typeof to === "string" ? { to: to.slice(0, MAX_ADDRESS_LENGTH) } : {}),
	        },
	      };
	    }

	    if (isStakeIntent(intent)) {
	      const { amount, token, validator } = intent.params;
	      return {
	        ...common,
	        params: {
	          amount: amount.slice(0, MAX_AMOUNT_LENGTH),
	          token: token.slice(0, MAX_TOKEN_LENGTH),
	          ...(typeof validator === "string" ? { validator: validator.slice(0, MAX_ADDRESS_LENGTH) } : {}),
	        },
	      };
	    }

	    if (isCustomIntent(intent)) {
	      const { programId, data, accounts } = intent.params;
	      return {
	        ...common,
	        params: {
	          programId: programId.slice(0, MAX_ADDRESS_LENGTH),
	          data: data.slice(0, MAX_DATA_LENGTH),
	          accounts: Array.isArray(accounts)
	            ? accounts.slice(0, MAX_ACCOUNTS).map((a) => ({
	              address: a.address.slice(0, MAX_ADDRESS_LENGTH),
	              isSigner: Boolean(a.isSigner),
	              isWritable: Boolean(a.isWritable),
	            }))
	            : [],
	        },
	      };
	    }

	    return {
	      ...common,
	      params: intent.params,
	    } as TransactionIntent;
	  }

	  /**
	   * Log an audit entry for a transaction attempt.
	   * S1-05 fix: deep-clones the intent to prevent shared references.
	   * S6: logger.log() now returns boolean; catch AuditCircuitOpenError.
   */
	  private async logAudit(
	    intent: TransactionIntent,
	    ruleAudits: PolicyRuleAudit[],
	    finalDecision: AuditEntry["finalDecision"],
	    txResult?: { txId: string; status: "confirmed" | "failed" },
	  ): Promise<void> {
	    try {
	      const safeIntent = this.sanitizeIntentForAudit(intent);
	      const intentId = typeof intent.id === "string" ? intent.id : safeIntent.id ?? "unknown";

	      const entry: AuditEntry = {
	        timestamp: Date.now(),
	        intentId,
	        agentId: safeIntent.metadata?.agentId,
	        intent: safeIntent,
	        policyDecisions: ruleAudits.map((a) => ({ ...a })),
	        finalDecision: structuredClone(finalDecision),
	        transactionResult: txResult ? { ...txResult } : undefined,
	      };

	      await this.logger.log(entry);
	    } catch (err) {
	      if (err instanceof AuditCircuitOpenError) {
	        // Audit is now broken — future transactions will be blocked
	        // But don't break the current transaction flow
	      }
	      // Other logging failures are swallowed (backward compatible)
	    }
	  }

  // ── Tool call handlers ──────────────────────────────────────────────

  /**
   * HIGH-11 fix: All tool handlers validate input types at runtime before use.
   * Prevents agent-controlled non-string values from being stored in audit log.
   */
  private async handleTransfer(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    if (typeof input.to !== "string") return { success: false, error: "Missing or invalid 'to' parameter" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    if (typeof input.token !== "string") return { success: false, error: "Missing or invalid 'token' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;

    const result = await this.execute({
      type: "transfer",
      chain: input.chain as ChainId,
      params: { to: input.to, amount: input.amount, token: input.token },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleSwap(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    if (typeof input.fromToken !== "string") return { success: false, error: "Missing or invalid 'fromToken' parameter" };
    if (typeof input.toToken !== "string") return { success: false, error: "Missing or invalid 'toToken' parameter" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const maxSlippage = typeof input.maxSlippage === "number" ? input.maxSlippage : undefined;

    const result = await this.execute({
      type: "swap",
      chain: input.chain as ChainId,
      params: {
        fromToken: input.fromToken, toToken: input.toToken, amount: input.amount,
        ...(maxSlippage !== undefined ? { maxSlippage } : {}),
      },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleMint(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    if (typeof input.collection !== "string") return { success: false, error: "Missing or invalid 'collection' parameter" };
    if (typeof input.metadataUri !== "string") return { success: false, error: "Missing or invalid 'metadataUri' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const to = typeof input.to === "string" ? input.to : undefined;

    const result = await this.execute({
      type: "mint",
      chain: input.chain as ChainId,
      params: { collection: input.collection, metadataUri: input.metadataUri, ...(to ? { to } : {}) },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleStake(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    if (typeof input.token !== "string") return { success: false, error: "Missing or invalid 'token' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const validator = typeof input.validator === "string" ? input.validator : undefined;

    const result = await this.execute({
      type: "stake",
      chain: input.chain as ChainId,
      params: { amount: input.amount, token: input.token, ...(validator ? { validator } : {}) },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleCustom(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    if (typeof input.programId !== "string") return { success: false, error: "Missing or invalid 'programId' parameter" };
    if (typeof input.data !== "string") return { success: false, error: "Missing or invalid 'data' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;

	    let accounts: Array<{
	      address: string;
	      isSigner: boolean;
	      isWritable: boolean;
	    }>;
	    try {
	      if (typeof input.accounts === "string" && input.accounts.length > MAX_ACCOUNTS_JSON_LENGTH) {
	        return {
	          success: false,
	          error: `Invalid 'accounts' parameter: exceeds max length of ${MAX_ACCOUNTS_JSON_LENGTH} characters`,
	        };
	      }

	      const raw =
	        typeof input.accounts === "string"
	          ? JSON.parse(input.accounts)
	          : input.accounts;

      // S5-02 fix: validate parsed JSON structure — reject non-arrays and invalid elements
      if (!Array.isArray(raw)) {
        return {
          success: false,
          error:
            "Invalid 'accounts' parameter: must be a valid JSON array of { address, isSigner, isWritable }",
        };
      }
	      for (const item of raw) {
	        if (
	          !item ||
	          typeof item !== "object" ||
	          typeof item.address !== "string" ||
	          typeof item.isSigner !== "boolean" ||
	          typeof item.isWritable !== "boolean"
	        ) {
	          return {
	            success: false,
	            error:
	              "Invalid account entry: each account must have { address: string, isSigner: boolean, isWritable: boolean }",
	          };
	        }
	        if (item.address.trim() === "") {
	          return { success: false, error: "Invalid account entry: 'address' must be a non-empty string" };
	        }
	        if (item.address.length > MAX_ADDRESS_LENGTH) {
	          return { success: false, error: `Invalid account entry: 'address' exceeds max length of ${MAX_ADDRESS_LENGTH}` };
	        }
	        if (item.address.trim() !== item.address) {
	          return { success: false, error: "Invalid account entry: 'address' must not include leading or trailing whitespace" };
	        }
	        try {
	          if (!this.chain.isValidAddress(item.address)) {
	            return { success: false, error: `Invalid account entry: 'address' is not a valid ${this.chain.chain} address` };
	          }
	        } catch {
	          return { success: false, error: `Invalid account entry: failed to validate address for chain "${this.chain.chain}"` };
	        }
	      }
	      accounts = raw;
	    } catch {
	      return {
        success: false,
        error:
          "Invalid 'accounts' parameter: must be a valid JSON array of { address, isSigner, isWritable }",
      };
    }

    const result = await this.execute({
      type: "custom",
      chain: input.chain as ChainId,
      params: {
        programId: input.programId,
        data: input.data,
        accounts,
      },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleGetBalance(
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    // S5-01 fix: runtime validation — handleGetBalance bypasses execute() pipeline
    if (typeof input.token !== "string" || input.token.trim() === "") {
      return {
        success: false,
        error: "The 'token' parameter must be a non-empty string.",
      };
    }
    const balance = await this.getBalance(input.token);
    return { success: true, data: balance };
  }

  private async handleGetPolicy(): Promise<ToolCallResult> {
    const policy = await this.getPolicy();
    return { success: true, data: policy };
  }

  private async handleGetHistory(
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const limit =
      typeof input.limit === "number" ? input.limit : undefined;
    const history = await this.getTransactionHistory(limit);
    return { success: true, data: history };
  }

  private transactionResultToToolResult(
    result: TransactionResult,
  ): ToolCallResult {
    return {
      success: result.status === "confirmed",
      data: result,
      error:
        result.status === "denied" || result.status === "failed"
          ? result.error?.message ?? result.summary
          : undefined,
    };
  }

  // ── Policy introspection helpers ────────────────────────────────────

  /**
   * HIGH-09 fix: Only expose limit configuration, NOT current spending counters.
   * Prevents agents from calculating exact remaining budget for optimal exploitation.
   */
  private populateSpendingLimits(
    summary: PolicySummary,
    rule: SpendingLimitRule,
  ): void {
    const config = rule.getConfig();
    if (config.perTransaction) {
      summary.spendingLimits.perTransaction = {
        amount: config.perTransaction.amount,
        token: config.perTransaction.token,
      };
    }
    if (config.daily) {
      summary.spendingLimits.daily = {
        amount: config.daily.amount,
        token: config.daily.token,
      };
    }
    if (config.weekly) {
      summary.spendingLimits.weekly = {
        amount: config.weekly.amount,
        token: config.weekly.token,
      };
    }
    if (config.monthly) {
      summary.spendingLimits.monthly = {
        amount: config.monthly.amount,
        token: config.monthly.token,
      };
    }
  }

  private populateAllowlist(
    summary: PolicySummary,
    rule: AllowlistRule,
  ): void {
    const config = rule.getConfig();
    summary.allowlistedAddresses = config.allowAddresses?.length ?? 0;
    summary.allowlistedPrograms = config.allowPrograms?.length ?? 0;
  }

  /**
   * HIGH-09 fix: Only expose rate limit configuration, NOT current counter values.
   */
  private populateRateLimits(
    summary: PolicySummary,
    rule: RateLimitRule,
  ): void {
    const config = rule.getConfig();
    summary.rateLimits = {
      maxPerMinute: config.maxTransactionsPerMinute,
      maxPerHour: config.maxTransactionsPerHour,
    };
  }

  private populateTimeWindow(
    summary: PolicySummary,
    rule: TimeWindowRule,
  ): void {
    const config = rule.getConfig();
    let isActive = true;
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: config.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const weekday =
        parts
          .find((p) => p.type === "weekday")
          ?.value?.toLowerCase()
          ?.slice(0, 3) ?? "";
      const hour = parseInt(
        parts.find((p) => p.type === "hour")?.value ?? "0",
        10,
      );
      const minute = parseInt(
        parts.find((p) => p.type === "minute")?.value ?? "0",
        10,
      );
      const currentMinutes = hour * 60 + minute;

      isActive = config.windows.some((w) => {
        if (!w.days.includes(weekday as (typeof w.days)[number])) return false;
        const startMin =
          parseInt(w.start.split(":")[0]!, 10) * 60 +
          parseInt(w.start.split(":")[1]!, 10);
        const endMin =
          parseInt(w.end.split(":")[0]!, 10) * 60 +
          parseInt(w.end.split(":")[1]!, 10);
        if (startMin <= endMin) {
          return currentMinutes >= startMin && currentMinutes < endMin;
        }
        return currentMinutes >= startMin || currentMinutes < endMin;
      });
    } catch {
      isActive = false;
    }

    summary.activeHours = {
      timezone: config.timezone,
      isCurrentlyActive: isActive,
    };
  }

  private populateApprovalGate(
    summary: PolicySummary,
    rule: ApprovalGateRule,
  ): void {
    const config = rule.getConfig();
    summary.approvalRequired = {
      above: {
        amount: config.above.amount,
        token: config.above.token,
      },
    };
  }
}
