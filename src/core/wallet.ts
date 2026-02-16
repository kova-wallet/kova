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
 *
 * SUPPLY-010: DEPENDENCY TRUST — This module imports from @solana/web3.js (via chain
 * adapters), @solana/spl-token, and better-sqlite3 (via store). These are trust-critical
 * dependencies that handle key material, transaction construction, and data persistence.
 * Pin exact versions in package-lock.json and audit regularly with `npm audit`.
 * Consider using npm's `--ignore-scripts` flag and verifying package integrity hashes.
 *
 * ARCH-02 cross-reference: See security_audit_team10 ARCH-02 for full analysis.
 * T8-F12 SECURITY NOTE — NO AUTHENTICATION LAYER:
 * This SDK does not implement caller authentication (passwords, sessions, OAuth, MFA,
 * API keys). Any code that obtains a reference to an AgentWallet instance can call
 * execute(), handleToolCall(), or any other method. The agentId field is explicitly
 * self-reported and untrusted (see M-56). Authentication and access control MUST be
 * enforced at the transport/application layer above this SDK. For multi-agent deployments,
 * each agent should have its own AgentWallet instance with agent-specific policy rules
 * to enforce isolation via the policy engine rather than caller identity.
 */

import { randomUUID, createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { isTransferIntent, isSwapIntent, isMintIntent, isStakeIntent, isCustomIntent } from "./intent.js";
import type { TransactionIntent, IntentMetadata } from "./intent.js";
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
// M-55 fix: WALLET_TOOL_NAMES no longer enumerated in error messages (but still
// imported for MED-T3-08 constructor validation of enabledTools).
import { WALLET_TOOL_NAMES, type WalletToolName } from "../adapters/tools.js";
import { SpendingLimitRule } from "../policy/rules/spending-limit.js";
import { normalizeTokenId } from "../policy/utils.js";
import { AllowlistRule } from "../policy/rules/allowlist.js";
import { RateLimitRule } from "../policy/rules/rate-limit.js";
import { TimeWindowRule } from "../policy/rules/time-window.js";
import { ApprovalGateRule } from "../policy/rules/approval-gate.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import { PrefixedStore } from "../stores/prefixed.js";
import type { ChainId } from "./intent.js";

/** Maximum number of history entries that can be requested */
const MAX_HISTORY_LIMIT = 1000;

/**
 * M-23 fix: Default timeout for mutex acquisition in milliseconds.
 * If the execute mutex cannot be acquired within this period (e.g., due to
 * a long-running approval wait), the caller receives an error instead of
 * blocking indefinitely. Prevents head-of-line blocking.
 */
const DEFAULT_MUTEX_TIMEOUT_MS = 30_000;

/**
 * Default TTL for idempotency keys (24 hours in seconds).
 * CORE-014 fix: Now configurable via AgentWalletConfig.idempotencyTtl.
 */
const DEFAULT_IDEMPOTENCY_TTL = 86_400;

/** Store key prefix for idempotency */
const IDEMPOTENCY_PREFIX = "idempotency:";

/** Valid chain IDs */
const VALID_CHAINS = new Set<string>(["solana", "ethereum", "base"]);

/**
 * HIGH-21 fix: Runtime-validated ChainId parser. Replaces unsafe `as ChainId`
 * type assertions which trust agent-provided strings without validation.
 * Returns the validated ChainId or null if invalid.
 */
function parseChainId(value: unknown): ChainId | null {
  if (typeof value !== "string") return null;
  if (VALID_CHAINS.has(value)) return value as ChainId;
  return null;
}

/** Valid intent types */
const VALID_TYPES = new Set(["transfer", "swap", "mint", "stake", "custom"]);

/** HIGH-10 fix: Maximum length limits for string inputs to prevent memory exhaustion */
const MAX_ADDRESS_LENGTH = 128;
const MAX_TOKEN_LENGTH = 64;
/**
 * L-07 fix: Minimum amount to reject dust transfers below fee threshold.
 *
 * LOW-T2-02 fix: This is the wallet-layer dust threshold (0.000001 in human-readable
 * units). It rejects intents outright during validation, before they reach the chain
 * adapter. The chain layer (src/chains/solana/utils.ts toSmallestUnit()) has a separate
 * dust threshold (1000 smallest units) that emits an advisory warning at the token-unit
 * level. The two thresholds are intentionally different:
 * - Wallet layer (here): human-readable, applies uniformly, hard rejection.
 * - Chain layer: smallest-unit, token-aware, advisory warning only.
 * Do not unify them — they protect against different attack vectors at different layers.
 */
const MIN_DUST_AMOUNT = 0.000001;
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

/**
 * MED-26 fix: Strip control characters (C0: U+0000-U+001F, DEL: U+007F,
 * C1: U+0080-U+009F) from strings before interpolating into summaries.
 * Prevents log injection, terminal escape sequences, and invisible characters
 * that could mislead operators reviewing audit logs.
 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

const DECIMAL_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

/**
 * M-43 fix: Canonical JSON serializer that deep-sorts object keys deterministically.
 * Ensures that { a: 1, b: 2 } and { b: 2, a: 1 } produce identical JSON output,
 * which is required for idempotency hash stability. Without canonical serialization,
 * semantically identical intents could produce different hashes due to key ordering
 * differences across JSON.stringify implementations or object construction order.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  // MED-T3-05 fix: Filter out prototype pollution keys (__proto__, constructor, prototype).
  // Unlike the audit logger's sortKeysDeep() which already filters these, this function
  // did not, creating an inconsistency. A crafted intent with __proto__ keys could inject
  // unexpected properties during deserialization of the canonical JSON output.
  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const sortedKeys = Object.keys(obj).filter((k) => !DANGEROUS_KEYS.has(k)).sort();
  const entries = sortedKeys.map(
    (key) => JSON.stringify(key) + ":" + canonicalJsonStringify(obj[key])
  );
  return "{" + entries.join(",") + "}";
}

/**
 * L-13 fix: Normalize amount strings by stripping leading zeros so that
 * "00.5" and "0.5" produce the same idempotency hash. Preserves the single
 * leading zero before a decimal point (e.g., "0.5" stays "0.5").
 */
function normalizeAmountForHash(amount: string): string {
  // Strip leading zeros but preserve "0" before decimal point
  // e.g., "00.5" -> "0.5", "007" -> "7", "0.5" -> "0.5", "0" -> "0"
  const normalized = amount.replace(/^0+/, "");
  if (normalized === "" || normalized.startsWith(".")) {
    return "0" + normalized;
  }
  return normalized;
}

/**
 * CRIT-12 fix: Sanitize policy denial reasons before returning them to the agent.
 * Strips specific numeric values (amounts, limits, remaining budget, counters) from
 * denial messages to prevent policy reconnaissance. An agent that knows exact limits
 * can craft transactions just below thresholds or calculate remaining budget.
 *
 * ARCH-10 cross-reference: See security_audit_team10 ARCH-10 for full analysis.
 * CORE-012 TRADEOFF: This function intentionally over-strips numeric values rather
 * than under-strips. Over-stripping (replacing harmless numbers like rule IDs) produces
 * slightly less informative denial messages, but under-stripping (allowing amounts or
 * limits to leak) would enable policy reconnaissance attacks. In a security context,
 * over-stripping is the safer default. If specific rule names or identifiers are
 * needed in denial messages, they should use non-numeric identifiers.
 */
function sanitizePolicyDenialForAgent(message: string): string {
  // L-05 fix: Timing side channel in policy denial messages is accepted as low-risk.
  // Policy denials return faster than allowed transactions (which go through build/sign/
  // broadcast), but the timing difference is minimal and unavoidable without artificial
  // latency. An attacker can distinguish "denied" from "allowed" but not which rule denied.

  // H-05 fix: Strip specific rule names from denial reasons to prevent reconnaissance.
  // Rule names like "spending-limit", "rate-limit-per-minute", "allowlist" reveal the
  // policy structure and help attackers craft evasion strategies.
  let sanitized = message;
  sanitized = sanitized.replace(/\brule[:\s]+["']?[\w-]+["']?/gi, "policy rule");
  sanitized = sanitized.replace(/\b(?:spending[_-]?limit|rate[_-]?limit|allowlist|time[_-]?window|approval[_-]?gate|circuit[_-]?breaker)[\w-]*/gi, "policy rule");

  // CORE-012 + L-11 fix: Replace ALL numeric values including single-digit numbers.
  // Previously single-digit numbers were preserved, but limits like "5 SOL" or "1 USD"
  // are security-sensitive and enable policy reconnaissance.
  sanitized = sanitized.replace(/\d+(\.\d+)?/g, "[restricted]");
  return sanitized;
}

/**
 * CORE-001 fix: Sanitize transaction error messages before returning them to the agent.
 * Strips RPC URLs, internal error codes, and sensitive details from chain adapter
 * error messages to prevent information leakage about infrastructure (RPC endpoints,
 * internal error codes, stack traces). Uses the same approach as sanitizePolicyDenialForAgent.
 */
function sanitizeTransactionError(message: string): string {
  let sanitized = message;
  // Strip URLs (http/https/wss) that may expose RPC endpoint addresses
  sanitized = sanitized.replace(/https?:\/\/[^\s,)}\]"']+/gi, "[restricted]");
  sanitized = sanitized.replace(/wss?:\/\/[^\s,)}\]"']+/gi, "[restricted]");
  // Replace numeric values (error codes, port numbers, byte offsets, etc.)
  sanitized = sanitized.replace(/\d+(\.\d+)?/g, "[restricted]");
  return sanitized;
}

/**
 * H-14 fix: Strip dangerous keys from parsed JSON to prevent prototype pollution.
 * JSON.parse() can produce objects with __proto__, constructor, or prototype keys
 * that, when spread or assigned, can pollute Object.prototype and affect all
 * downstream code. This recursively removes these keys from parsed objects.
 */
function stripDangerousKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripDangerousKeys);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    clean[key] = stripDangerousKeys(value);
  }
  return clean;
}

function validateDecimalAmount(value: string): string | null {
  if (value.length > MAX_AMOUNT_LENGTH) return `'amount' exceeds max length of ${MAX_AMOUNT_LENGTH}`;
  if (value.trim() !== value) return "'amount' must not include leading or trailing whitespace";
  // LOW-01 fix: Do not echo raw input values in error messages (prevents log injection)
  if (!DECIMAL_AMOUNT_REGEX.test(value)) {
    return "invalid amount. Must be a positive decimal string (e.g. '1.5')";
  }
  const fractional = value.split(".")[1];
  if (fractional && fractional.length > MAX_AMOUNT_DECIMALS) {
    return `'amount' has more than ${MAX_AMOUNT_DECIMALS} decimal places`;
  }
  const parsed = parseFloat(value);
  if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
    return "invalid amount. Must be a finite positive number";
  }
  // L-07 fix: Reject dust amounts below fee threshold. Transactions with amounts
  // this small are economically meaningless (below network fees) and can be used
  // to probe policy rules or inflate audit logs without real financial intent.
  if (parsed < MIN_DUST_AMOUNT) {
    return `amount below minimum dust threshold of ${MIN_DUST_AMOUNT}`;
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
  /**
   * CORE-014 fix: TTL for idempotency keys in seconds.
   * Determines how long a duplicate intent ID returns a cached result instead of
   * re-executing. Too short risks duplicate transactions; too long wastes store space.
   * Must be a positive finite number. Default: 86400 (24 hours).
   */
  idempotencyTtl?: number;
  /**
   * STORE-004 fix: HMAC secret key for idempotency cache authenticity.
   * When provided, each cached idempotency result is stored with an HMAC-SHA256
   * tag computed over the JSON payload. On cache read, the HMAC is verified before
   * trusting the cached result. This prevents an attacker with store write access
   * from forging cached "confirmed" results for transactions that never executed.
   * Store this key separately from the cache store (e.g., environment variable,
   * secret manager). If not set, idempotency cache entries are stored as plaintext
   * (backwards-compatible but vulnerable to forgery).
   */
  idempotencyHmacKey?: string | Buffer;
  /**
   * ARCH-13 cross-reference: See security_audit_team10 ARCH-13 for full analysis.
   * STORE-005 fix: Optional prefix for store key isolation.
   * When multiple AgentWallet instances share a Store backend, each wallet
   * MUST use a unique prefix (e.g., derived from the signer's public key)
   * to prevent cross-wallet interference in spending limits, rate counters,
   * circuit breaker state, and audit logs.
   * When set, the store is automatically wrapped in a PrefixedStore.
   */
  storePrefix?: string;
  /**
   * M-23 fix: Timeout in milliseconds for acquiring the execute mutex.
   * If the mutex cannot be acquired within this period (e.g., due to a
   * long-running human approval wait), the execute() call fails with an
   * error instead of blocking indefinitely. Default: 30000 (30 seconds).
   */
  mutexTimeoutMs?: number;
  /**
   * H-06 fix: Set of tool names that are enabled for dispatch via handleToolCall().
   * If not provided, defaults to safe read-only tools only (wallet_get_balance,
   * wallet_get_transaction_history). Dangerous tools (wallet_execute_custom,
   * wallet_get_policy) and write tools (wallet_transfer, wallet_swap, wallet_mint,
   * wallet_stake) must be explicitly enabled.
   *
   * M-59 fix: wallet_get_policy is included in this check — it is not invocable
   * unless explicitly listed in enabledTools.
   */
  enabledTools?: ReadonlySet<string>;
}

/** Default safe tools when no enabledTools is configured */
const DEFAULT_ENABLED_TOOLS: ReadonlySet<string> = new Set([
  "wallet_get_balance",
  "wallet_get_transaction_history",
]);

export class AgentWallet {
  private readonly signer: Signer;
  private readonly chain: ChainAdapter;
  private readonly policy: PolicyEngine;
  private readonly store: Store;
  private readonly logger: AuditLogger;
  private readonly circuitBreaker?: CircuitBreaker;
  /** CORE-014 fix: Configurable idempotency TTL (seconds) */
  private readonly idempotencyTtl: number;
  /** STORE-004 + CRIT-05 fix: HMAC key for idempotency cache authenticity (always set) */
  private readonly idempotencyHmacKey: Buffer;
  /** S1-04 fix: mutex to serialize execute() calls and prevent concurrent policy bypass */
  private executeLock: Promise<void> = Promise.resolve();
  /** M-23 fix: Timeout for mutex acquisition (milliseconds) */
  private readonly mutexTimeoutMs: number;
  /** H-06 fix: Set of tool names enabled for dispatch */
  private readonly enabledTools: ReadonlySet<string>;

  constructor(config: AgentWalletConfig) {
    this.signer = config.signer;
    this.chain = config.chain;
    this.policy = config.policy;
    // STORE-005 fix: Auto-wrap store with PrefixedStore when storePrefix is configured.
    // This ensures per-wallet isolation of spending limits, rate counters, circuit breaker
    // state, audit logs, and idempotency keys when multiple wallets share a store backend.
    const effectiveStore = config.storePrefix
      ? PrefixedStore.wrapIfNeeded(config.store, config.storePrefix)
      : config.store;
    this.store = effectiveStore;
    // Create AuditLogger — use provided logger, or create one with config
    if (config.logger) {
      this.logger = config.logger;
    } else if (config.onAuditFailure) {
      this.logger = new AuditLogger({
        store: effectiveStore,
        onAuditFailure: config.onAuditFailure,
      });
    } else {
      this.logger = new AuditLogger(effectiveStore);
    }

    // CORE-014 fix: Validate and set configurable idempotency TTL
    if (config.idempotencyTtl !== undefined) {
      if (typeof config.idempotencyTtl !== "number" || !Number.isFinite(config.idempotencyTtl) || config.idempotencyTtl <= 0) {
        throw new Error("AgentWalletConfig: 'idempotencyTtl' must be a positive finite number (seconds)");
      }
      this.idempotencyTtl = config.idempotencyTtl;
    } else {
      this.idempotencyTtl = DEFAULT_IDEMPOTENCY_TTL;
    }

    // STORE-004 fix: Store HMAC key for idempotency cache authenticity.
    // CRIT-05 fix: Auto-generate a random 32-byte HMAC key if none is provided.
    // Without an HMAC key, the idempotency cache has no integrity protection and an
    // attacker with store write access can forge cached "confirmed" results for
    // transactions that never executed. Auto-generating ensures every wallet instance
    // has cache integrity protection by default, even if the operator forgets to configure one.
    // H-11 fix: Enforce minimum HMAC key length of 32 bytes (64 hex chars) to prevent
    // weak keys that are vulnerable to brute-force attacks.
    if (config.idempotencyHmacKey) {
      // T1-F8 fix: Detect hex-encoded keys and use the appropriate encoding.
      // A 64-char hex string represents 32 bytes. Using UTF-8 encoding on a hex string
      // would produce 64 bytes (one per char), defeating the key length validation
      // and producing a different HMAC than intended.
      const keyBuffer = typeof config.idempotencyHmacKey === "string"
        ? (/^[0-9a-fA-F]+$/.test(config.idempotencyHmacKey) && config.idempotencyHmacKey.length >= 64
          ? Buffer.from(config.idempotencyHmacKey, "hex")
          : Buffer.from(config.idempotencyHmacKey, "utf-8"))
        : config.idempotencyHmacKey;
      if (keyBuffer.length < 32) {
        throw new Error(
          "AgentWalletConfig: 'idempotencyHmacKey' must be at least 32 bytes (64 hex characters). " +
          "Short HMAC keys are vulnerable to brute-force attacks."
        );
      }
      this.idempotencyHmacKey = keyBuffer;
    } else {
      // CRIT-05: Auto-generate a cryptographically random 32-byte key so that
      // idempotency cache integrity is always protected, even without explicit config.
      this.idempotencyHmacKey = randomBytes(32);
      // T8-F8 fix: Warn when the HMAC key is auto-generated in non-test environments.
      // After a process restart, all existing idempotency cache entries become
      // unverifiable (HMAC mismatch), effectively clearing the cache and allowing
      // duplicate transaction execution for previously submitted intents.
      try {
        if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
          process.emitWarning(
            "AgentWallet: idempotencyHmacKey was auto-generated. After a process restart, " +
            "existing idempotency cache entries will become unverifiable. For production use, " +
            "provide a persistent idempotencyHmacKey in the config to prevent duplicate " +
            "transaction execution across restarts.",
            "KovaIdempotencyKeyWarning",
          );
        }
      } catch { /* non-fatal */ }
    }

    // Create CircuitBreaker unless disabled
    // CRIT-T4-02 fix: Use effectiveStore (which includes prefix) instead of raw config.store.
    // Previously, the circuit breaker received the unprefixed store, meaning all wallets
    // sharing a store backend shared a single circuit breaker state. A malicious agent on
    // one wallet could block ALL other wallets by triggering consecutive denials.
    if (config.circuitBreaker !== false) {
      this.circuitBreaker = new CircuitBreaker(effectiveStore, config.circuitBreaker ?? undefined);
    }

    // M-23 fix: Configurable mutex timeout to prevent indefinite blocking
    this.mutexTimeoutMs = config.mutexTimeoutMs ?? DEFAULT_MUTEX_TIMEOUT_MS;

    // H-06 fix: Configure enabled tools. Default to safe read-only tools only.
    this.enabledTools = config.enabledTools ?? DEFAULT_ENABLED_TOOLS;

    // MED-T3-08 fix: Warn when enabledTools contains tool names not recognized by the
    // wallet's dispatch logic. This catches typos and adapter/wallet desync issues at
    // construction time rather than silently failing at invocation time, where the
    // unrecognized tool would hit the "Unknown tool" default case.
    const knownToolNames = new Set<string>(WALLET_TOOL_NAMES);
    for (const tool of this.enabledTools) {
      if (!knownToolNames.has(tool)) {
        console.warn(
          `[AgentWallet] Warning: enabledTools contains unrecognized tool "${tool}". ` +
          `This tool will not be dispatched by the wallet. Known tools: ${WALLET_TOOL_NAMES.join(", ")}`,
        );
      }
    }

    // T6-F14 fix: Emit a one-time startup warning when KOVA_AUDIT_STDERR is enabled.
    // When set, audit fallback data (intent IDs and types) flows to stderr on audit
    // failure. Operators should be aware that this metadata may be captured by log
    // aggregators or container runtimes without the same access controls as the audit store.
    if (typeof process !== "undefined" && process.env.KOVA_AUDIT_STDERR === "1") {
      process.emitWarning(
        "KOVA_AUDIT_STDERR=1 is set. Audit fallback data (intent IDs, types) will be written " +
        "to stderr when the primary audit store is unavailable. Ensure stderr output has " +
        "equivalent access controls to the audit store.",
        "SecurityWarning",
      );
    }
  }

  /**
   * CRIT-T5-03 fix: Gracefully shut down the wallet, releasing all held resources.
   * - Destroys the circuit breaker (stops heartbeat timer, clears state)
   * - Destroys the audit logger (zeroes HMAC key)
   * - Optionally destroys the signer (zeroes key material for LocalSigner)
   *
   * After calling destroy(), the wallet cannot process any more transactions.
   * This method is idempotent — calling it multiple times is safe.
   *
   * CONC-08 NOTE — GRACEFUL SHUTDOWN:
   * This method does NOT wait for in-flight transactions to complete and does NOT
   * register SIGINT/SIGTERM handlers. Callers should:
   *   1. Stop submitting new execute() calls before calling destroy().
   *   2. Optionally register process.on('SIGTERM', () => wallet.destroy()) in
   *      their startup code to handle container/orchestrator signals.
   *   3. Be aware that calling destroy() while a transaction is in-flight may
   *      leave spending counters inflated (consumed budget without a transaction)
   *      or audit log entries incomplete.
   * See security_audit_team9 CONC-08 for full analysis.
   */
  async destroy(): Promise<void> {
    // Destroy circuit breaker (stops heartbeat interval timer, allows clean process exit)
    if (this.circuitBreaker) {
      try {
        await this.circuitBreaker.destroy();
      } catch (err: unknown) {
        // ARCH-15 fix: Emit observable warning instead of silently swallowing.
        const msg = err instanceof Error ? err.message : "Unknown error";
        process.emitWarning(`AgentWallet.destroy: circuit breaker cleanup failed: ${msg}`, "KovaDestroyWarning");
      }
    }

    // Destroy audit logger (zeroes HMAC key material in memory)
    try {
      await this.logger.destroy();
    } catch (err: unknown) {
      // ARCH-15 fix: Emit observable warning instead of silently swallowing.
      const msg = err instanceof Error ? err.message : "Unknown error";
      process.emitWarning(`AgentWallet.destroy: audit logger cleanup failed: ${msg}`, "KovaDestroyWarning");
    }

    // Destroy signer (zeroes private key material for LocalSigner, clears cache for MpcSigner)
    try {
      await this.signer.destroy();
    } catch (err: unknown) {
      // ARCH-15 fix: Emit observable warning instead of silently swallowing.
      const msg = err instanceof Error ? err.message : "Unknown error";
      process.emitWarning(`AgentWallet.destroy: signer cleanup failed: ${msg}`, "KovaDestroyWarning");
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
    // CORE-005 fix: Deep-clone intent at entry to eliminate TOCTOU window.
    // Prevents external mutation of the intent object from affecting the pipeline
    // after validation has passed. Objects with non-cloneable values (functions,
    // symbols, DOM nodes) are caught and rejected as validation failures.
    // M-54 fix: Do NOT access properties of the original intent object in the catch
    // block. A hostile intent could have getter traps on .id or other fields that
    // execute arbitrary code. Use a generic error without referencing the original.
    // L-14 fix: Do not mention "structuredClone" or other implementation details in
    // error messages — use a generic message that doesn't leak internals.
    try {
      intent = structuredClone(intent);
    } catch {
      return {
        status: "failed",
        summary: "Validation failed: intent contains non-cloneable values",
        intentId: "unknown",
        timestamp: Date.now(),
        error: {
          code: "VALIDATION_FAILED",
          message: "Intent contains non-cloneable values. All intent fields must be plain data.",
        },
      };
    }

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
    // M-23 fix: Add a timeout to mutex acquisition to prevent head-of-line blocking.
    // If the mutex cannot be acquired within the configured timeout (default 30s),
    // the call fails with an error rather than blocking indefinitely. This prevents
    // long-running approval waits from starving subsequent execute() calls.
    //
    // CONC-04 KNOWN LIMITATION: When ApprovalGateRule triggers, it blocks inside
    // the mutex for up to 5 minutes (DEFAULT_TIMEOUT_MS). All other execute() calls
    // are queued behind this wait. The 30-second mutex timeout partially mitigates
    // this, but callers experience up to 30s of latency per attempt. For high-throughput
    // deployments, reduce the approval timeout or use a background polling architecture.
    //
    // CONC-14 KNOWN LIMITATION: When a timeout fires, releaseLock() is called to
    // unblock the chain, but the long-running holder's slot is still in the chain.
    // This is safe under single-instance deployment because the holder's eventual
    // releaseLock() just resolves an already-resolved promise (no-op). However,
    // this pattern should not be extended to distributed locking.
    //
    // CONC-21 KNOWN LIMITATION: This mutex is process-local. It provides no protection
    // across multiple AgentWallet instances or Node.js processes sharing the same store.
    // All TOCTOU protections, idempotency, spending limits, and audit integrity depend
    // on single-instance deployment. See CRIT-02 in circuit-breaker.ts.
    let releaseLock: () => void;
    const previousLock = this.executeLock;
    this.executeLock = new Promise<void>((resolve) => { releaseLock = resolve; });

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), this.mutexTimeoutMs);
    });

    const lockResult = await Promise.race([
      previousLock.then(() => "acquired" as const),
      timeoutPromise,
    ]);

    if (lockResult === "timeout") {
      // Release our slot in the lock chain so subsequent callers aren't permanently blocked
      releaseLock!();
      return {
        status: "failed",
        summary: "Transaction failed: execute mutex acquisition timed out",
        intentId: intent.id ?? "unknown",
        timestamp: Date.now(),
        error: {
          code: "TRANSACTION_FAILED",
          message: `Execute mutex acquisition timed out after ${this.mutexTimeoutMs}ms. A previous transaction may be awaiting approval.`,
        },
      };
    }

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
    // H-18 KNOWN LIMITATION: Idempotency cache race in multi-instance deployments.
    // The check-then-act pattern (read cache → miss → execute → write cache) is not
    // atomic across multiple AgentWallet instances sharing the same store. Two instances
    // could both read a cache miss for the same intent ID and execute the transaction
    // twice. This is acceptable for single-instance deployment. Multi-instance setups
    // MUST use an external distributed lock or database-level CAS (compare-and-swap)
    // to guarantee exactly-once execution.
    //
    // L-33 KNOWN LIMITATION: No permanent anti-replay beyond idempotency TTL.
    // After the idempotency TTL expires (default 24 hours), the same intent ID can be
    // reused and will be treated as a fresh transaction. This is acceptable for the
    // current use case (short-lived agent sessions) but operators requiring permanent
    // deduplication should implement an external append-only ledger of executed intent IDs
    // that persists beyond the TTL window.
    //
    // MED-08 fix: Include hash of intent parameters in idempotency key.
    // Previously only the intent ID was used, so an agent could reuse an ID
    // with different parameters and receive a cached "confirmed" result for
    // a transaction that never executed with those parameters.
    // L-13 fix: Normalize amount strings before hashing so that "00.5" and "0.5"
    // produce the same idempotency key, preventing duplicate transactions.
    // M-43 fix: Use canonical JSON serialization with sorted keys to ensure
    // deterministic hash output regardless of object key ordering.
    // M-44 fix: Use the full SHA-256 hash (64 hex chars) instead of a truncated
    // 64-bit slice to avoid birthday collisions at ~2^32 operations.
    const paramsForHash = structuredClone({ type: normalizedIntent.type, chain: normalizedIntent.chain, params: normalizedIntent.params });
    // Normalize amount fields in params for idempotency deduplication
    const hashParams = paramsForHash.params as unknown as Record<string, unknown>;
    if (typeof hashParams.amount === "string") {
      hashParams.amount = normalizeAmountForHash(hashParams.amount);
    }
    const paramsHash = createHash("sha256")
      .update(canonicalJsonStringify(paramsForHash))
      .digest("hex");
    // MED-17 fix: Include chain as a plaintext prefix in the idempotency key.
    // This prevents cross-chain collisions where the same intent ID + params hash
    // on different chains could return a cached result from the wrong chain.
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${normalizedIntent.chain}:${intentId}:${paramsHash}`;
    // HIGH-15 fix: Wrap store.get in try-catch so store errors don't crash execute().
    // A store failure during idempotency check should not block transaction processing.
    let cachedResult: string | null = null;
    try {
      cachedResult = await this.store.get(idempotencyKey);
    } catch {
      // Store error during idempotency check — proceed with fresh execution
    }
    if (cachedResult !== null) {
      try {
        // CORE-009 SECURITY NOTE: Idempotency cache poisoning risk.
        // An attacker with store write access can inject a forged "confirmed" result
        // for a transaction that never executed. Without HMAC authentication, the
        // cache entry is trusted at face value. Operators MUST configure
        // `idempotencyHmacKey` in AgentWalletConfig to mitigate this risk.
        // When the HMAC key is set, the STORE-004 fix below verifies each cached
        // entry's HMAC-SHA256 tag before trusting it, rejecting forged entries as
        // cache misses. The HMAC key should be stored separately from the cache
        // store (e.g., in an environment variable or secret manager).
        //
        // STORE-004 fix: If HMAC key is configured, verify the HMAC tag before
        // trusting the cached result. Forged entries are treated as cache misses.
        let cacheJson = cachedResult;
        if (this.idempotencyHmacKey) {
          const colonIndex = cachedResult.indexOf(":");
          if (colonIndex === -1) {
            // No HMAC tag present — treat as untrusted (cache miss)
            cacheJson = "";
          } else {
            const storedHmac = cachedResult.slice(0, colonIndex);
            const payload = cachedResult.slice(colonIndex + 1);
            const expectedHmac = createHmac("sha256", this.idempotencyHmacKey).update(payload).digest("hex");
            // CRIT-01 fix: Use constant-time comparison to prevent timing side-channel
            // attacks that could allow an attacker to forge HMAC tags byte-by-byte.
            // Plain string comparison (===) leaks information about which byte position
            // first differs, enabling iterative forgery. timingSafeEqual compares in
            // constant time regardless of where the mismatch occurs.
            // Length check first: if lengths differ, the HMAC is invalid. We still avoid
            // leaking timing info by using Buffer length comparison (integer comparison
            // is inherently constant-time).
            const storedBuf = Buffer.from(storedHmac, "hex");
            const expectedBuf = Buffer.from(expectedHmac, "hex");
            if (storedBuf.length !== expectedBuf.length || !timingSafeEqual(storedBuf, expectedBuf)) {
              // HMAC mismatch — forged or corrupted entry, treat as cache miss
              cacheJson = "";
            } else {
              cacheJson = payload;
            }
          }
        }
        if (cacheJson === "") {
          // STORE-004: HMAC verification failed — fall through to fresh execution
        } else {
          // S2-16 fix: Validate parsed cache entry before returning
          // H-14 fix: Strip __proto__, constructor, and prototype keys from parsed
          // JSON to prevent prototype pollution attacks via forged cache entries.
          const parsed = stripDangerousKeys(JSON.parse(cacheJson)) as Record<string, unknown>;
          // HIGH-22 fix: Strengthen cached TransactionResult validation
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.status === "string" &&
            typeof parsed.intentId === "string" &&
            typeof parsed.timestamp === "number" &&
            typeof parsed.summary === "string" &&
            (parsed.status === "confirmed" || parsed.status === "denied" || parsed.status === "failed" || parsed.status === "pending")
          ) {
            return parsed as TransactionResult;
          }
          // Invalid cache schema — proceed with fresh execution
        }
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
    // CORE-011: Pass intent type for per-intent-type circuit breaker isolation
    // H-17 DESIGN NOTE: The circuit breaker check-then-act pattern (check → policy → record)
    // is intentionally non-atomic. This is safe because the execute() mutex serializes all
    // calls to executeInternal(), so no concurrent check-then-act race can occur within a
    // single AgentWallet instance. Multi-instance deployments sharing a store may see
    // slightly inconsistent circuit breaker state, but this is acceptable — the circuit
    // breaker is a safety heuristic, not a precise counter.
    // H-31 fix: Wrap circuit breaker store operations in try/catch. On store error,
    // fail-closed (treat as circuit open / deny) to maintain security invariants.
    if (this.circuitBreaker) {
      let cbReason: string | null;
      try {
        cbReason = await this.circuitBreaker.check(undefined, normalizedIntent.type);
      } catch (cbErr) {
        // H-31: Store error during circuit breaker check — fail-closed (deny)
        const errMsg = cbErr instanceof Error ? cbErr.message : String(cbErr);
        console.error(`[KOVA] Circuit breaker check failed (fail-closed): ${errMsg}`);
        return {
          status: "denied",
          summary: "Denied: circuit breaker check unavailable (fail-closed)",
          intentId,
          timestamp: Date.now(),
          error: {
            code: "CIRCUIT_BREAKER_OPEN",
            message: "Circuit breaker store is unavailable. Transactions are blocked until the store is restored.",
          },
        };
      }
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
    // CRIT-03 fix: Auto-inject chain adapter's getValueInUSD for USD-normalized spending limits
    // POLICY-017 fix: getValueInUSD is now constructor-injected into PolicyEngine.
    // Pass only (intent, now?) — the engine uses its own price oracle reference.
    const evaluationResult = await this.policy.evaluate(normalizedIntent);
    const policyDecision = evaluationResult.decision;
    const ruleAudits = evaluationResult.ruleAudits;

    // S6: Record outcome for circuit breaker
    // CORE-011: Pass intent type for per-intent-type circuit breaker isolation
    // H-31 fix: Wrap recordOutcome in try/catch — store errors during recording
    // should not break the transaction flow, but are logged for observability.
    if (this.circuitBreaker) {
      try {
        await this.circuitBreaker.recordOutcome(policyDecision.decision, undefined, normalizedIntent.type);
      } catch (cbErr) {
        const errMsg = cbErr instanceof Error ? cbErr.message : String(cbErr);
        console.error(`[KOVA] Circuit breaker recordOutcome failed: ${errMsg}`);
        // Non-fatal: the transaction has already been evaluated by policy.
        // Failing to record the outcome means the circuit breaker count may drift,
        // but this is safer than aborting a policy-approved transaction.
      }
    }

    // 3. If denied, return immediately with error
    if (policyDecision.decision === "DENY") {
      // CRIT-12 fix: Sanitize denial reason before exposing to agent to prevent
      // policy reconnaissance (exact limit amounts, remaining budget, counters).
      // HIGH-13 fix: Also sanitizes policy evaluation error reasons that may
      // contain internal details from rule.evaluate() failures.
      const sanitizedReason = sanitizePolicyDenialForAgent(policyDecision.reason);
      // H-05 fix: Do NOT include policyDecision.rule in the error response returned
      // to the agent. Specific rule names (e.g., "spending-limit", "allowlist") enable
      // reconnaissance — an attacker learns exactly which rule denied, helping them
      // craft evasion strategies. The rule name is still available in the audit log.
      const error: TransactionError = {
        code: "POLICY_DENIED",
        message: sanitizedReason,
      };

      const result: TransactionResult = {
        status: "denied",
        summary: `Denied by policy: ${sanitizedReason}`,
        intentId,
        timestamp: Date.now(),
        error,
      };

      // M-52 fix: Wrap logAudit in try/catch for denied results. If audit logging
      // fails, still return the denial to the caller (fail-closed on the transaction,
      // not on the response). The denial decision itself is security-critical.
      try {
        await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
      } catch {
        // Audit failure for denied results is non-fatal — the denial still stands
      }
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

      // M-52 fix: Wrap logAudit in try/catch for pending results. If audit logging
      // fails, still return the pending result to the caller.
      try {
        await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
      } catch {
        // Audit failure for pending results is non-fatal — the pending status still stands
      }
      // S2-03 fix: Don't cache pending results — approval may arrive on retry
      return result;
    }

    // 5. Build, sign, and broadcast the transaction
    //
    // H-02 fix: On post-policy transaction failure (build, sign, simulate, broadcast),
    // attempt best-effort rollback of spending counters that were incremented during
    // policy evaluation. This prevents budget from being permanently consumed by
    // failed transactions. The rollback is safe because the execute mutex serializes
    // all calls, eliminating TOCTOU risks during the rollback window.
    //
    // ROLLBACK CAVEAT: Rollback is best-effort. If the store is unavailable during
    // rollback, the counter will remain inflated (safe direction: under-count budget).
    // Rate limit counters (RateLimitRule) are NOT rolled back since they track
    // attempts, not successful transactions.
    try {
      const signerAddress = await this.signer.getAddress();

      // Build unsigned transaction
      const unsignedTx = await this.chain.buildTransaction(normalizedIntent, signerAddress);

      // CRIT-02 fix: Simulate transaction before signing to detect on-chain errors early.
      // This catches insufficient balance, program errors, and other issues without spending fees.
      // MED-26 note: Only simulation.success is checked. The simulation logs are not parsed
      // to verify the expected program was invoked or accounts were correctly modified.
      // A transaction that simulates successfully but performs unintended side effects
      // (e.g., unlimited token approval) would pass. Instruction-level verification
      // would require chain-specific parsing of simulation logs.
      const simulation = await this.chain.simulateTransaction(unsignedTx.data);
      if (!simulation.success) {
        const rawSimMessage = simulation.error ?? "Transaction simulation failed";
        const sanitizedSimMessage = sanitizeTransactionError(rawSimMessage);
        const simError: TransactionError = {
          code: "SIMULATION_FAILED",
          message: sanitizedSimMessage,
        };

        const simResult: TransactionResult = {
          status: "failed",
          summary: `Simulation failed: ${sanitizedSimMessage}`,
          intentId,
          timestamp: Date.now(),
          error: simError,
        };

        await this.logAudit(normalizedIntent, ruleAudits, policyDecision, undefined);
        // H-02 fix: Roll back spending counters on simulation failure
        await this.rollbackSpendingCounters(normalizedIntent);
        return simResult;
      }

      // Sign it
      const signedTx = await this.signer.sign(unsignedTx);

      // CORE-002 / CHAIN-005 fix: Verify that the signed transaction's message bytes
      // match the original unsigned transaction. Detects if a compromised signer modified
      // the transaction instructions, accounts, or other data during signing.
      // The chain adapter's verifyTransactionIntegrity() throws if the message was altered.
      if (this.chain.verifyTransactionIntegrity) {
        this.chain.verifyTransactionIntegrity(unsignedTx.data, signedTx.data);
      }

      // Broadcast to chain
      const txId = await this.chain.broadcast(signedTx.data);

      const result: TransactionResult = {
        status: "confirmed",
        txId,
        summary: this.buildSummary(normalizedIntent),
        intentId,
        timestamp: Date.now(),
      };

      // MED-25 fix: Retry audit logging for confirmed transactions.
      // A confirmed transaction with no audit trail is a compliance gap.
      let auditLogged = false;
      for (let attempt = 0; attempt < 3 && !auditLogged; attempt++) {
        try {
          await this.logAudit(normalizedIntent, ruleAudits, policyDecision, { txId, status: "confirmed" });
          auditLogged = true;
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }

      // CRIT-06 fix: If audit logging failed for a confirmed transaction, mark the
      // result as audit-incomplete and emit a stderr fallback so the confirmed tx
      // is observable even when the store is down.
      // STORE-009 fix: Only log intent ID, type, and status to stderr. Transaction
      // details (txId, addresses, amounts), chain identifiers, and timestamps are
      // stripped to prevent leaking sensitive metadata to stderr, which may be
      // captured by process managers, log aggregators, or container runtimes
      // without the same access controls as the primary audit store.
      // H-30 fix: If audit logging failed for a confirmed transaction, do NOT return
      // the confirmed result to the caller. A confirmed transaction without an audit
      // trail is a compliance violation that requires manual investigation. Returning
      // the result would allow the caller to proceed as if everything is fine.
      if (!auditLogged) {
        // HIGH-T5-02 fix: Only emit audit fallback to stderr when explicitly enabled.
        // In production, stderr may be captured by log aggregators, container runtimes,
        // or process managers without the same access controls as the audit store.
        // Logging intent IDs and types to stderr could leak operational metadata.
        if (process.env.NODE_ENV === "test" || process.env.KOVA_AUDIT_STDERR === "1") {
          try {
            console.error("[KOVA AUDIT FALLBACK]", JSON.stringify({
              intentId,
              type: normalizedIntent.type,
              status: "confirmed",
            }));
          } catch {
            // Last-resort fallback — if even JSON.stringify fails, do nothing
          }
        }
        return {
          status: "failed",
          summary: "Transaction confirmed on-chain but audit logging failed. Manual investigation required.",
          intentId,
          timestamp: Date.now(),
          error: {
            code: "STORE_ERROR",
            message: "Transaction was confirmed on-chain but the audit trail could not be written. " +
              "The transaction ID has been logged to stderr. Contact operations for manual reconciliation.",
          },
        };
      }

      await this.cacheResult(idempotencyKey, result);
      return result;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = sanitizeTransactionError(rawMessage);

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
      // H-02 fix: Roll back spending counters on post-policy transaction failure
      await this.rollbackSpendingCounters(normalizedIntent);
      // HIGH-16 fix: Do NOT cache failed transaction results. Failures may be
      // transient (network timeout, RPC down, insufficient balance), and caching
      // them would prevent the agent from retrying a legitimate transaction.
      return result;
    }
  }

  /**
   * Get the wallet's balance for a specific token.
   * MED-35 fix: Validates input at the public API boundary.
   *
   * H-16 fix: CONCURRENCY NOTE — This method does NOT acquire the execute mutex.
   * It is safe to call concurrently because it performs a stateless read-only RPC
   * call with no shared mutable state. However, the balance returned may be stale
   * if a concurrent execute() call is in-flight (read-after-write inconsistency).
   * Callers should not use getBalance() for authorization decisions.
   * CONC-16 cross-reference: See security_audit_team9 CONC-16 for full analysis.
   * ARCH-18 cross-reference: See security_audit_team10 ARCH-18 for read/write separation analysis.
   *
   * H-32 fix: Returns a structured error result instead of throwing raw exceptions.
   * RPC errors are sanitized to prevent leaking endpoint URLs and internal details.
   */
  async getBalance(token: string): Promise<TokenBalance> {
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("getBalance: 'token' must be a non-empty string");
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new Error(`getBalance: 'token' exceeds max length of ${MAX_TOKEN_LENGTH}`);
    }
    try {
      const address = await this.signer.getAddress();
      return await this.chain.getBalance(address, token);
    } catch (err) {
      // H-32 fix: Sanitize RPC errors — strip URLs and internal details
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeTransactionError(rawMessage);
      throw new Error(`getBalance failed: ${sanitized}`);
    }
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
    // M-62 fix: Redact circuit breaker numeric thresholds from the policy summary
    // returned to agents. Exposing exact threshold and cooldown values enables
    // an attacker to calculate exactly how many denials trigger the breaker and
    // how long to wait before retrying.
    if (this.circuitBreaker) {
      const isOpen = await this.circuitBreaker.isOpen();
      summary.circuitBreaker = {
        threshold: "[redacted]" as unknown as number,
        cooldownMs: "[redacted]" as unknown as number,
        isOpen,
      };
    }

    return summary;
  }

  /**
   * Get recent transaction history from the audit log.
   * S1-06 fix: limit is validated and clamped to [1, MAX_HISTORY_LIMIT].
   * MED-35 fix: Throws on non-number input instead of silently correcting.
   *
   * H-16 fix: CONCURRENCY NOTE — This method does NOT acquire the execute mutex.
   * It reads from the audit log which is append-only. Concurrent execute() calls
   * may cause the returned history to be slightly stale (missing the in-flight tx),
   * which is acceptable for read-only display purposes.
   *
   * H-32 fix: Wraps store access in try/catch. Returns sanitized error on failure.
   * M-58 fix: Supports optional address redaction via redactAddresses parameter.
   */
  async getTransactionHistory(limit: number = 10, options?: { redactAddresses?: boolean }): Promise<TransactionResult[]> {
    if (typeof limit !== "number") {
      throw new Error("getTransactionHistory: 'limit' must be a number");
    }
    if (!Number.isFinite(limit) || limit < 1) {
      limit = 10;
    }
    const sanitizedLimit = Math.min(Math.floor(limit), MAX_HISTORY_LIMIT);
    try {
      const entries = await this.logger.getRecent(sanitizedLimit);
      return entries.map((entry): TransactionResult => {
        const status = this.mapAuditStatus(entry);
        let summary = this.buildSummary(entry.intent);
        const intentId = entry.intentId;
        const timestamp = entry.timestamp;

        // M-58 fix: Redact recipient addresses in history responses when enabled.
        // Prevents pattern analysis of transaction destinations by agents that
        // may have been prompt-injected.
        if (options?.redactAddresses) {
          // Redact addresses in summaries (e.g., "So1a...b2c3" → "So1...xyz")
          summary = summary.replace(/\b[A-HJ-NP-Za-km-z1-9]{32,44}\b/g, (addr) =>
            addr.length > 8 ? `${addr.slice(0, 3)}...${addr.slice(-3)}` : addr
          );
        }

        // CORE-013: Construct the correct discriminated union variant based on status
        switch (status) {
          case "confirmed":
            return { status, txId: entry.transactionResult?.txId ?? "", summary, intentId, timestamp };
          case "denied":
            return { status, summary, intentId, timestamp };
          case "failed":
            return { status, summary, intentId, timestamp };
          case "pending":
            return { status, summary, intentId, timestamp };
        }
      });
    } catch (err) {
      // H-32 fix: Sanitize store/RPC errors — strip URLs and internal details
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeTransactionError(rawMessage);
      throw new Error(`getTransactionHistory failed: ${sanitized}`);
    }
  }

  /**
   * Handle a tool call from an AI agent.
   * Dispatches to the appropriate wallet method based on tool name.
   */
  async handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      // H-06 fix: Check tool enablement before dispatch. Only tools in the configured
      // enabledTools set are dispatched. This prevents dangerous tools (wallet_execute_custom,
      // wallet_get_policy) from being invoked even if the agent knows the tool name.
      // M-59 fix: wallet_get_policy is included in this check.
      if (!this.enabledTools.has(name)) {
        // M-11 fix: Sanitize tool name to prevent injection. Strip control chars
        // and truncate to a reasonable length before including in the error.
        // M-55 fix: Do NOT enumerate available tools — this leaks which tools
        // (including dangerous ones) are configured.
        const sanitizedName = stripControlChars(typeof name === "string" ? name.slice(0, 64) : "");
        return {
          success: false,
          error: `Tool not enabled: ${sanitizedName}`,
        };
      }

      // MED-T3-01 fix: The `as WalletToolName` cast is safe here because the
      // enabledTools.has(name) check above already rejects any string not in the
      // configured tool set. The default case below provides a secondary safety net,
      // returning "Unknown tool" for any value that somehow passes the guard but
      // doesn't match a known case — ensuring fail-closed behavior.
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
        default: {
          // M-11 fix: Sanitize tool name before reflecting in error response.
          // M-55 fix: Do NOT list available tools — prevents reconnaissance.
          const sanitizedName = stripControlChars(typeof name === "string" ? name.slice(0, 64) : "");
          return {
            success: false,
            error: `Unknown tool: ${sanitizedName}`,
          };
        }
      }
    } catch (err) {
      // MED-28 fix: Log the actual error to audit before returning generic message.
      // This preserves debugging context while still sanitizing the agent-facing response.
      // HIGH-14 fix: Use crypto.randomUUID() for intentId instead of Date.now() to avoid
      // collisions and predictability. Mark intent type as "internal_error" (via metadata
      // isInternalError flag) so audit consumers can distinguish fabricated error entries
      // from real agent-initiated custom intents.
      // CORE-007 RESOLVED: The intent type remains "custom" because IntentType is a union
      // of "transfer"|"swap"|"mint"|"stake"|"custom" — adding "internal_error" would
      // require a schema change. Instead, the `isInternalError: true` flag on the audit
      // entry distinguishes these fabricated entries from real custom intents. Audit
      // consumers MUST check `isInternalError` to filter synthetic error entries.
      try {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // L-06 fix: Sanitize tool name before including in audit entry to prevent
        // log injection via crafted tool names with control characters.
        const safeName = stripControlChars(typeof name === "string" ? name.slice(0, 64) : "unknown");
        await this.logger.log({
          timestamp: Date.now(),
          intentId: `tool-error-${randomUUID()}`,
          intent: {
            type: "custom" as const,
            chain: this.chain.chain as ChainId,
            params: { programId: "internal", data: "", accounts: [] },
            metadata: { reason: `handleToolCall error in ${safeName}: ${stripControlChars(errorMsg.slice(0, 200))}` },
          },
          policyDecisions: [],
          finalDecision: {
            decision: "DENY",
            rule: "internal",
            reason: `Internal error: ${stripControlChars(errorMsg.slice(0, 200))}`,
          },
          isInternalError: true,
        } as AuditEntry & { isInternalError: boolean });
      } catch {
        // Audit failure is non-fatal
      }
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

    // LOW-01 fix: Do not echo raw input values in error messages to prevent log injection
    if (!VALID_TYPES.has(intent.type)) {
      return "Invalid intent type. Must be one of: transfer, swap, mint, stake, custom";
    }

    if (!VALID_CHAINS.has(intent.chain)) {
      return "Invalid chain. Must be one of: solana, ethereum, base";
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
	      // L-09 fix: Reject intent IDs containing null bytes. Null bytes can cause
	      // truncation in C-based storage backends (SQLite, filesystem) and create
	      // inconsistencies between the ID as seen by JavaScript and as stored.
	      if (intent.id.includes("\0")) {
	        return "Intent ID contains null bytes";
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
	      // M-56 fix: SECURITY NOTE — agentId is self-reported by the agent and MUST NOT
	      // be used for authorization decisions. An agent can impersonate any other agent
	      // by setting an arbitrary agentId. It is useful only for audit trail correlation
	      // and debugging. For access control, use cryptographic identity (e.g., API keys,
	      // signed tokens) verified at the transport layer before reaching the wallet.
	      if (metadata.agentId !== undefined) {
	        if (typeof metadata.agentId !== "string" || metadata.agentId.trim() === "") {
	          return "Metadata 'agentId' must be a non-empty string";
	        }
	        if (metadata.agentId.length > MAX_METADATA_ID_LENGTH) {
	          return `Metadata 'agentId' exceeds max length of ${MAX_METADATA_ID_LENGTH}`;
	        }
	        // M-56 fix: Validate agentId format — only allow alphanumeric, hyphens, underscores,
	        // and dots to prevent injection attacks via agent ID fields.
	        if (!/^[\w.@-]+$/.test(metadata.agentId)) {
	          return "Metadata 'agentId' contains invalid characters. Only alphanumeric, hyphens, underscores, dots, and @ are allowed";
	        }
	      }
	      if (metadata.taskId !== undefined) {
	        if (typeof metadata.taskId !== "string" || metadata.taskId.trim() === "") {
	          return "Metadata 'taskId' must be a non-empty string";
	        }
	        if (metadata.taskId.length > MAX_METADATA_ID_LENGTH) {
	          return `Metadata 'taskId' exceeds max length of ${MAX_METADATA_ID_LENGTH}`;
	        }
	        // MED-T3-02 fix: Validate taskId character composition matching agentId pattern.
	        // Without this, taskId could contain control characters, shell metacharacters, or
	        // injection payloads that propagate to logs, audit entries, and approval messages.
	        if (!/^[\w.@-]+$/.test(metadata.taskId)) {
	          return "Metadata 'taskId' contains invalid characters. Only alphanumeric, hyphens, underscores, dots, and @ are allowed";
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
	        // M-60 fix: Cap maxSlippage to 50% (0.5) to prevent MEV extraction.
	        // A 100% slippage tolerance allows sandwich attacks to extract the entire
	        // swap value. Even 50% is generous — most legitimate swaps use 0.5-5%.
	        if (maxSlippage > 0.5) {
	          return "Swap: 'maxSlippage' exceeds maximum of 0.5 (50%). High slippage enables MEV extraction";
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
	      // CORE-015 fix: Validate metadataUri is a well-formed URL (https, ipfs, or ar protocol)
	      try {
	        const parsed = new URL(metadataUri);
	        if (!["https:", "ipfs:", "ar:"].includes(parsed.protocol)) {
	          return `Mint: 'metadataUri' must use https, ipfs, or ar protocol (got ${parsed.protocol})`;
	        }
	        // HIGH-T3-03 fix: SSRF protection for https URLs. Reject hostnames that
	        // resolve to private/reserved IP ranges, localhost, or link-local addresses.
	        if (parsed.protocol === "https:") {
	          const hostname = parsed.hostname.toLowerCase();
	          if (
	            hostname === "localhost" ||
	            hostname === "127.0.0.1" ||
	            hostname === "[::1]" ||
	            hostname === "0.0.0.0" ||
	            hostname.endsWith(".local") ||
	            hostname.endsWith(".internal") ||
	            /^10\./.test(hostname) ||
	            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
	            /^192\.168\./.test(hostname) ||
	            /^169\.254\./.test(hostname) ||
	            // SSRF-MED-02 fix: Add CGNAT range (100.64.0.0/10), commonly used in
	            // cloud/container environments with custom DNS resolvers
	            /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname) ||
	            // SSRF-MED-02 fix: Add IPv6 ULA (fd00::/8, fc00::/7)
	            hostname.startsWith("[fd") ||
	            hostname.startsWith("[fc") ||
	            // SSRF-MED-02 fix: Add IPv6-mapped IPv4 (e.g., [::ffff:192.168.1.1])
	            hostname.startsWith("[::ffff:")
	          ) {
	            return "Mint: 'metadataUri' must not point to private/reserved IP ranges or localhost (SSRF protection)";
	          }
	        }
	      } catch {
	        return "Mint: 'metadataUri' is not a valid URL";
	      }
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

    // MED-27 fix: If the type is valid but no type guard matched, the params shape
    // is wrong (e.g., data: 12345 instead of string for custom intent). The type
    // guards validate param field types, so failure means malformed params.
    if (
      !isTransferIntent(intent) && !isSwapIntent(intent) &&
      !isMintIntent(intent) && !isStakeIntent(intent) && !isCustomIntent(intent)
    ) {
      return `Intent params do not match the expected shape for type "${intent.type}"`;
    }

    return null;
  }

  /** S1-02 fix: Cache a result for idempotency
   *  STORE-004 fix: When idempotencyHmacKey is configured, stores an HMAC-SHA256
   *  tag alongside the JSON payload to prevent forged cache entries.
   *  CONC-07 fix: Use setIfNotExists to prevent overwriting an existing cache entry
   *  from a concurrent instance. If another instance already cached a result for this
   *  intent, we preserve theirs rather than overwriting with ours (first-writer-wins). */
  private async cacheResult(key: string, result: TransactionResult): Promise<void> {
    try {
      // T6-F7 fix: Strip sensitive fields from the cached result before serialization.
      // The idempotency cache has a 24-hour default TTL, meaning full transaction details
      // would persist on disk for a full day. Only cache the fields needed for idempotency
      // replay: status, txId, intentId, timestamp, summary, and error codes. Raw params
      // (recipient addresses, token amounts) from the original intent are excluded.
      const sanitizedResult: Record<string, unknown> = {
        status: result.status,
        txId: result.txId,
        intentId: result.intentId,
        timestamp: result.timestamp,
        summary: result.summary,
      };
      if (result.error) {
        sanitizedResult.error = { code: result.error.code, message: result.error.message };
      }
      const json = JSON.stringify(sanitizedResult);
      let value: string;
      if (this.idempotencyHmacKey) {
        // STORE-004: Compute HMAC over the JSON and store as "hmac:json" so
        // the reader can split, verify, and only trust authenticated entries.
        const hmac = createHmac("sha256", this.idempotencyHmacKey).update(json).digest("hex");
        value = hmac + ":" + json;
      } else {
        value = json;
      }
      // CONC-07 fix: Use setIfNotExists for defense-in-depth against concurrent writes.
      // In multi-instance deployments, another instance may have already cached a result.
      // setIfNotExists preserves the first writer's result (first-writer-wins semantics).
      const wasSet = await this.store.setIfNotExists(key, value, this.idempotencyTtl);
      if (!wasSet) {
        // Another instance already cached a result — this is expected in multi-instance
        // deployments and indicates a potential double-execution (documented as H-18).
        // Fall through silently; the existing cached result takes precedence.
      }
    } catch {
      // Cache failure must not break the transaction flow
    }
  }

  /**
   * Assign ID and timestamp if not already set.
   * CORE-018 fix: Clamp createdAt to within ±5 minutes of current time to prevent
   * stale or future-dated intents from bypassing time-window policy rules.
   */
  private normalizeIntent(intent: TransactionIntent): TransactionIntent {
    const now = Date.now();
    let createdAt = intent.createdAt ?? now;
    // CORE-018: Reject intents with createdAt more than 5 minutes in the past or future
    const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;
    if (Math.abs(createdAt - now) > MAX_CLOCK_DRIFT_MS) {
      createdAt = now; // Clamp stale/future timestamps to current time
    }
    return {
      ...intent,
      id: intent.id ?? randomUUID(),
      createdAt,
    };
  }

  /**
   * Build a human-readable summary from an intent.
   * MED-26 fix: All interpolated values are stripped of control characters
   * (C0/C1 controls, DEL, etc.) to prevent log injection and terminal escape attacks.
   */
  private buildSummary(intent: TransactionIntent): string {
    if (isTransferIntent(intent)) {
      const { to, amount, token } = intent.params;
      const shortAddr = to.length > 8 ? `${to.slice(0, 4)}...${to.slice(-4)}` : to;
      return `Sent ${stripControlChars(amount)} ${stripControlChars(token)} to ${stripControlChars(shortAddr)}`;
    }

    if (isSwapIntent(intent)) {
      const { fromToken, toToken, amount } = intent.params;
      return `Swapped ${stripControlChars(amount)} ${stripControlChars(fromToken)} for ${stripControlChars(toToken)}`;
    }

    if (isMintIntent(intent)) {
      return `Minted NFT from collection ${stripControlChars(intent.params.collection.slice(0, 8))}...`;
    }

    if (isStakeIntent(intent)) {
      const { amount, token } = intent.params;
      return `Staked ${stripControlChars(amount)} ${stripControlChars(token)}`;
    }

    return `Executed ${stripControlChars(intent.type)} on ${stripControlChars(intent.chain)}`;
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

	    // L-10 fix: Strip control characters from metadata fields before including in audit
	    // entries. Prevents log injection via crafted metadata values with terminal escape
	    // sequences, null bytes, or invisible characters that could mislead operators.
	    if (typeof raw.reason === "string") sanitized.reason = stripControlChars(raw.reason.slice(0, MAX_REASON_LENGTH));
	    if (typeof raw.agentId === "string") sanitized.agentId = stripControlChars(raw.agentId.slice(0, MAX_METADATA_ID_LENGTH));
	    if (typeof raw.taskId === "string") sanitized.taskId = stripControlChars(raw.taskId.slice(0, MAX_METADATA_ID_LENGTH));
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
	      // MED-18 fix: Invoke onAuditFailure callback for ALL transaction types,
	      // including denied transactions. Previously only the AuditLogger's internal
	      // callback was invoked; the wallet-level callback was silently swallowed here.
	      // This ensures operators are notified when audit logging fails for denials too.
	      if (this.logger.getOnAuditFailure()) {
	        try {
	          this.logger.getOnAuditFailure()!(err, this.logger.getFailureCount());
	        } catch {
	          // Callback failure is non-fatal
	        }
	      }
	    }
	  }

  /**
   * H-02 fix: Best-effort rollback of spending counters after post-policy transaction
   * failure. Iterates through policy rules and decrements spending limit counters
   * that were incremented during the policy evaluation phase. This is safe because
   * the execute mutex serializes all calls, preventing TOCTOU races during rollback.
   *
   * Only SpendingLimitRule counters are rolled back. RateLimitRule counters track
   * attempts (not successful transactions) and are intentionally not rolled back.
   *
   * HIGH-T1-06 fix: Each counter decrement is independently try/caught so a failure
   * on one window (e.g., daily) doesn't prevent rollback of others (weekly, monthly).
   * Rollback errors are tracked and logged for operational awareness.
   */
  private async rollbackSpendingCounters(intent: TransactionIntent): Promise<void> {
    const rollbackErrors: string[] = [];
    try {
      const rules = this.policy.getRules();
      for (const rule of rules) {
        if (rule instanceof SpendingLimitRule) {
          const amount = this.extractAmountForRollback(intent);
          if (amount === null) continue;
          const token = this.extractTokenForRollback(intent);
          const config = rule.getConfig();
          // HIGH-T3-05 fix: Read the key prefix from the SpendingLimitRule configuration
          // instead of hardcoding "spending:". If a custom prefix is configured, the
          // hardcoded prefix would target the wrong keys, causing rollback to silently fail.
          const keyPrefix = config.keyPrefix ?? "spending:";
          // HIGH-T3-04 fix: Normalize the token ID using the same normalizeTokenId()
          // function that SpendingLimitRule uses. Without this, casing differences
          // (e.g., "sol" vs "SOL") cause rollback to target a different key than
          // the one that was incremented.
          const normalizedToken = normalizeTokenId(token);
          const windowKeys: Array<{ window: string; ttl: number }> = [];
          if (config.daily) windowKeys.push({ window: "daily", ttl: 86_400 });
          if (config.weekly) windowKeys.push({ window: "weekly", ttl: 604_800 });
          if (config.monthly) windowKeys.push({ window: "monthly", ttl: 2_592_000 });
          for (const { window } of windowKeys) {
            const key = `${keyPrefix}${window}:${normalizedToken}`;
            try {
              // CRIT-T3-02 fix: Remove the erroneous 1e9 scale factor. The
              // SpendingLimitRule increments counters by the RAW amount (no scale factor),
              // so rollback must decrement by the same raw amount. The old code multiplied
              // by 1e9, making rollback decrement ~1 billion times the original increment,
              // driving counters deeply negative and granting unlimited spending budget.
              await this.store.increment(key, -amount);
            } catch (err) {
              // Track the failure but continue rolling back other windows
              rollbackErrors.push(`${window}:${normalizedToken}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          // HIGH-T3-06 fix: Also roll back USD-denominated counters. Previously skipped
          // because the exact USD value depends on the price oracle at evaluation time.
          // Now we use a best-effort approach: re-query the price oracle if available,
          // and only skip if unavailable. Incorrect rollback values could over-count
          // remaining budget (unsafe), so we only rollback if we can get a current price.
          if (this.chain && typeof (this.chain as any).getValueInUSD === "function") {
            const usdWindowKeys: Array<{ window: string }> = [];
            if (config.dailyUSD) usdWindowKeys.push({ window: "daily" });
            if (config.weeklyUSD) usdWindowKeys.push({ window: "weekly" });
            if (config.monthlyUSD) usdWindowKeys.push({ window: "monthly" });
            if (usdWindowKeys.length > 0) {
              try {
                const usdValue = await (this.chain as any).getValueInUSD(token, String(amount));
                if (typeof usdValue === "number" && Number.isFinite(usdValue) && usdValue > 0) {
                  for (const { window } of usdWindowKeys) {
                    const usdKey = `${keyPrefix}${window}:USD`;
                    try {
                      await this.store.increment(usdKey, -usdValue);
                    } catch (err) {
                      rollbackErrors.push(`${window}:USD: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                }
              } catch {
                // Best-effort: if price oracle unavailable, USD counters reset via TTL
              }
            }
          }
        }
      }
    } catch (err) {
      rollbackErrors.push(`outer: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Log rollback failures for operational awareness (non-fatal)
    if (rollbackErrors.length > 0 && (process.env.NODE_ENV === "test" || process.env.KOVA_AUDIT_STDERR === "1")) {
      try {
        console.error(`[KOVA] Spending rollback partial failure (${rollbackErrors.length} errors): ${rollbackErrors.join("; ")}`);
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Extract numeric amount from intent for spending rollback.
   * INT-MED-01 fix: Aligned with SpendingLimitRule.extractAmount() to use BigInt-based
   * parsing for integer amounts, preventing parseFloat precision loss for large values.
   */
  private extractAmountForRollback(intent: TransactionIntent): number | null {
    let amountStr: string | undefined;
    if (isTransferIntent(intent)) amountStr = intent.params.amount;
    else if (isSwapIntent(intent)) amountStr = intent.params.amount;
    else if (isStakeIntent(intent)) amountStr = intent.params.amount;
    if (!amountStr) return null;

    // INT-MED-01 fix: Use BigInt for pure integer amounts (aligned with SpendingLimitRule)
    if (/^\d+$/.test(amountStr)) {
      try {
        const bigAmount = BigInt(amountStr);
        if (bigAmount <= 0n) return null;
        return Number(bigAmount);
      } catch {
        return null;
      }
    }
    // For decimal amounts, validate format before parseFloat
    if (!/^\d+\.\d+$/.test(amountStr)) return null;
    const parsed = parseFloat(amountStr);
    return (Number.isFinite(parsed) && parsed > 0) ? parsed : null;
  }

  /**
   * Extract token identifier from intent for spending rollback.
   * HIGH-T3-04 fix: Returns the raw token — normalization is applied in
   * rollbackSpendingCounters() using normalizeTokenId() for consistency.
   */
  private extractTokenForRollback(intent: TransactionIntent): string {
    if (isTransferIntent(intent)) return intent.params.token;
    if (isSwapIntent(intent)) return intent.params.fromToken;
    if (isStakeIntent(intent)) return intent.params.token;
    return "unknown";
  }

  // ── Tool call handlers ──────────────────────────────────────────────

  /**
   * HIGH-11 fix: All tool handlers validate input types at runtime before use.
   * Prevents agent-controlled non-string values from being stored in audit log.
   */
  private async handleTransfer(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    // HIGH-21 fix: Runtime-validate chain ID instead of unsafe `as ChainId` cast
    const chain = parseChainId(input.chain);
    if (!chain) return { success: false, error: "Invalid 'chain' parameter. Must be one of: solana, ethereum, base" };
    if (typeof input.to !== "string") return { success: false, error: "Missing or invalid 'to' parameter" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    if (typeof input.token !== "string") return { success: false, error: "Missing or invalid 'token' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;

    const result = await this.execute({
      type: "transfer",
      chain,
      params: { to: input.to, amount: input.amount, token: input.token },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleSwap(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    const chain = parseChainId(input.chain);
    if (!chain) return { success: false, error: "Invalid 'chain' parameter. Must be one of: solana, ethereum, base" };
    if (typeof input.fromToken !== "string") return { success: false, error: "Missing or invalid 'fromToken' parameter" };
    if (typeof input.toToken !== "string") return { success: false, error: "Missing or invalid 'toToken' parameter" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const maxSlippage = typeof input.maxSlippage === "number" ? input.maxSlippage : undefined;

    const result = await this.execute({
      type: "swap",
      chain,
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
    const chain = parseChainId(input.chain);
    if (!chain) return { success: false, error: "Invalid 'chain' parameter. Must be one of: solana, ethereum, base" };
    if (typeof input.collection !== "string") return { success: false, error: "Missing or invalid 'collection' parameter" };
    if (typeof input.metadataUri !== "string") return { success: false, error: "Missing or invalid 'metadataUri' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const to = typeof input.to === "string" ? input.to : undefined;

    const result = await this.execute({
      type: "mint",
      chain,
      params: { collection: input.collection, metadataUri: input.metadataUri, ...(to ? { to } : {}) },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleStake(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    const chain = parseChainId(input.chain);
    if (!chain) return { success: false, error: "Invalid 'chain' parameter. Must be one of: solana, ethereum, base" };
    if (typeof input.amount !== "string") return { success: false, error: "Missing or invalid 'amount' parameter" };
    if (typeof input.token !== "string") return { success: false, error: "Missing or invalid 'token' parameter" };
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    const validator = typeof input.validator === "string" ? input.validator : undefined;

    const result = await this.execute({
      type: "stake",
      chain,
      params: { amount: input.amount, token: input.token, ...(validator ? { validator } : {}) },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  private async handleCustom(input: Record<string, unknown>): Promise<ToolCallResult> {
    if (typeof input.chain !== "string") return { success: false, error: "Missing or invalid 'chain' parameter" };
    const chain = parseChainId(input.chain);
    if (!chain) return { success: false, error: "Invalid 'chain' parameter. Must be one of: solana, ethereum, base" };
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

	      // L-32 fix: Normalize accounts field — accept both string and object/array.
	      // If string, JSON.parse it. If parsing fails, the catch block returns an error.
	      // eslint-disable-next-line @typescript-eslint/no-explicit-any
	      let raw: any;
	      if (typeof input.accounts === "string") {
	        raw = JSON.parse(input.accounts);
	      } else if (Array.isArray(input.accounts)) {
	        raw = input.accounts;
	      } else {
	        return {
	          success: false,
	          error: "Invalid 'accounts' parameter: must be a JSON string or an array of account objects",
	        };
	      }

	      // M-15 fix: Strip prototype pollution keys (__proto__, constructor, prototype)
	      // from JSON.parse output. These keys can pollute Object.prototype when spread
	      // or assigned, affecting all downstream code.
	      raw = stripDangerousKeys(raw);

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
	      accounts = raw as Array<{ address: string; isSigner: boolean; isWritable: boolean }>;
	    } catch {
	      return {
        success: false,
        error:
          "Invalid 'accounts' parameter: must be a valid JSON array of { address, isSigner, isWritable }",
      };
    }

    const result = await this.execute({
      type: "custom",
      chain,
      params: {
        programId: input.programId,
        data: input.data,
        accounts,
      },
      metadata: reason ? { reason } : undefined,
    });
    return this.transactionResultToToolResult(result);
  }

  /**
   * HIGH-04 fix: handleGetBalance now includes rate limiting and audit logging.
   * Previously this bypassed the entire security pipeline (policy, audit, rate limits).
   * While read-only, unlimited unaudited RPC calls could DoS the RPC endpoint
   * and hide agent reconnaissance behavior from the audit trail.
   */
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

    // HIGH-04 / MED-03 fix: Rate limit read-only operations
    const rateLimited = await this.checkReadRateLimit();
    if (rateLimited) return rateLimited;

    const balance = await this.getBalance(input.token);

    // HIGH-04 fix: Audit log balance queries for visibility into agent behavior
    // MED-32 fix: Use a queryType field in metadata to distinguish read-only queries
    // from real transfer intents. Previously this used type: "transfer" with amount "0"
    // and to "self", which created a fabricated audit entry indistinguishable from a
    // real denied transfer. The queryType metadata field makes the intent clearly synthetic.
    // CORE-008 RESOLVED: The intent type remains "transfer" because AuditEntry.intent
    // requires a TransactionIntent whose type is constrained to IntentType (no "query"
    // variant). The `queryType: "balance"` metadata field is the distinguishing marker.
    // Audit consumers MUST check `metadata.queryType` to identify synthetic balance
    // query entries vs. real transfer intents.
    // L-34 fix: Balance query audit entries are flagged as synthetic via the
    // `isSyntheticQuery: true` field so audit consumers can distinguish them from
    // real transaction entries. This prevents synthetic entries from evicting real
    // ones in size-limited audit stores by allowing consumers to filter or route
    // synthetic entries to a separate namespace.
    try {
      await this.logger.log({
        timestamp: Date.now(),
        intentId: `balance-query-${randomUUID()}`,
        intent: {
          type: "transfer" as const,
          chain: this.chain.chain as ChainId,
          params: { to: "self", amount: "0", token: input.token },
          metadata: { reason: "balance_query", queryType: "balance" } as IntentMetadata & { queryType: string },
        },
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
        isSyntheticQuery: true,
      } as AuditEntry & { isSyntheticQuery: boolean });
    } catch {
      // Audit failure is non-fatal for read-only queries
    }

    return { success: true, data: balance };
  }

  /**
   * MED-03 fix: Rate limit policy queries to prevent timing/enumeration attacks.
   */
  private async handleGetPolicy(): Promise<ToolCallResult> {
    const rateLimited = await this.checkReadRateLimit();
    if (rateLimited) return rateLimited;
    const policy = await this.getPolicy();
    return { success: true, data: policy };
  }

  /**
   * MED-03 fix: Rate limit history queries to prevent enumeration without audit logging.
   */
  private async handleGetHistory(
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const rateLimited = await this.checkReadRateLimit();
    if (rateLimited) return rateLimited;
    const limit =
      typeof input.limit === "number" ? input.limit : undefined;
    const history = await this.getTransactionHistory(limit);
    return { success: true, data: history };
  }

  /**
   * MED-03 fix: Shared rate limiter for read-only tool operations.
   * Prevents RPC DoS via balance queries, timing attacks via policy queries,
   * and unauthenticated enumeration of transaction history.
   * Returns a ToolCallResult if rate limited, or null if allowed.
   *
   * M-21 fix: RACE CONDITION NOTE — With async stores, there is a race window
   * between setIfNotExists() and increment() where concurrent calls may both
   * see the counter as below the limit and both be allowed through. This is
   * acceptable for read operations because:
   * 1. Read operations are not security-critical (no funds at risk).
   * 2. The worst case is slightly exceeding the rate limit (e.g., 31 reads
   *    instead of 30 in a 1-minute window), which is harmless.
   * 3. The execute mutex serializes write operations separately.
   * 4. Adding a mutex here would create head-of-line blocking for reads.
   */
  private async checkReadRateLimit(): Promise<ToolCallResult | null> {
    try {
      // CORE-006 KNOWN LIMITATION: This rate limit key is global across all agents.
      // A single noisy agent can exhaust the read quota for all agents sharing this
      // wallet instance. Per-agent isolation requires either:
      //   (a) Threading agentId from handleToolCall → handler → checkReadRateLimit
      //       and scoping the key as `read_ops:${agentId}:minute`, or
      //   (b) Using PrefixedStore (src/stores/prefixed.ts) to give each agent its own
      //       key namespace, so rate limit keys are naturally isolated per-agent.
      // Until then, the global counter is a shared resource across all agents.
      const rateLimitKey = "read_ops:minute";
      await this.store.setIfNotExists(rateLimitKey, "0", 60);
      const count = await this.store.increment(rateLimitKey, 1);
      if (count > 30) {
        return {
          success: false,
          error: "Read operation rate limit exceeded (max 30/minute). Try again shortly.",
        };
      }
    } catch {
      // HIGH-14 fix: Fail-closed on store errors — deny the operation rather than
      // allowing unlimited unmetered reads when the store is down
      return {
        success: false,
        error: "Rate limit check temporarily unavailable. Try again shortly.",
      };
    }
    return null;
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
  /**
   * HIGH-T3-01 fix: Redact exact spending limit amounts from the policy summary.
   * Exposing exact thresholds enables policy reconnaissance — an attacker who has
   * prompt-injected the agent can learn the exact amounts to stay under to avoid
   * triggering controls. Only expose the token and whether a limit exists.
   */
  private populateSpendingLimits(
    summary: PolicySummary,
    rule: SpendingLimitRule,
  ): void {
    const config = rule.getConfig();
    if (config.perTransaction) {
      summary.spendingLimits.perTransaction = {
        amount: "[redacted]",
        token: config.perTransaction.token,
      };
    }
    if (config.daily) {
      summary.spendingLimits.daily = {
        amount: "[redacted]",
        token: config.daily.token,
      };
    }
    if (config.weekly) {
      summary.spendingLimits.weekly = {
        amount: "[redacted]",
        token: config.weekly.token,
      };
    }
    if (config.monthly) {
      summary.spendingLimits.monthly = {
        amount: "[redacted]",
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
  /**
   * HIGH-T3-01 fix: Redact exact rate limit thresholds from the policy summary.
   * Exposing exact numbers enables an attacker to calculate exactly how many
   * transactions they can make before hitting the limit.
   */
  private populateRateLimits(
    summary: PolicySummary,
    _rule: RateLimitRule,
  ): void {
    summary.rateLimits = {
      maxPerMinute: "[redacted]" as unknown as number,
      maxPerHour: "[redacted]" as unknown as number,
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

  /**
   * HIGH-T3-01 fix: Redact exact approval thresholds from the policy summary.
   * Exposing exact threshold values enables an attacker to craft transactions
   * just below the approval amount to bypass human review.
   */
  private populateApprovalGate(
    summary: PolicySummary,
    rule: ApprovalGateRule,
  ): void {
    const config = rule.getConfig();
    summary.approvalRequired = {
      above: {
        amount: "[redacted]",
        token: config.above.token,
      },
    };
  }
}
