export interface GlossaryEntry {
  /** Display text shown inline (the visible term) */
  term: string;
  /** Tooltip definition shown on hover */
  definition: string;
  /** Category for potential future grouping */
  category: "blockchain" | "sdk" | "ai";
}

export const glossary: Record<string, GlossaryEntry> = {
  // ── Blockchain / Crypto ──────────────────────────────────
  devnet: {
    term: "devnet",
    definition:
      "A free test network for Solana where tokens have no real value. Used for development and testing before deploying to mainnet.",
    category: "blockchain",
  },
  mainnet: {
    term: "mainnet",
    definition:
      "The primary Solana network where transactions involve real value. Also called mainnet-beta.",
    category: "blockchain",
  },
  rpc: {
    term: "RPC",
    definition:
      "Remote Procedure Call \u2014 an HTTP endpoint that lets your application communicate with a Solana node to submit transactions and read on-chain data.",
    category: "blockchain",
  },
  keypair: {
    term: "keypair",
    definition:
      "A pair of cryptographic keys (one public, one private) that identifies an account on Solana. The private key signs transactions; the public key is the account address.",
    category: "blockchain",
  },
  "private-key": {
    term: "private key",
    definition:
      "The secret half of a keypair. Used to sign transactions and prove ownership of an account. Must never be shared or exposed.",
    category: "blockchain",
  },
  "public-key": {
    term: "public key",
    definition:
      "The public half of a keypair. Serves as the account address on Solana. Safe to share \u2014 it is how others send you tokens.",
    category: "blockchain",
  },
  airdrop: {
    term: "airdrop",
    definition:
      "A free distribution of tokens. On Solana devnet, you can airdrop SOL to your wallet for testing at no cost.",
    category: "blockchain",
  },
  sol: {
    term: "SOL",
    definition:
      "The native token of the Solana blockchain. Used to pay transaction fees and as a medium of exchange. 1 SOL = 1,000,000,000 lamports.",
    category: "blockchain",
  },
  usdc: {
    term: "USDC",
    definition:
      "USD Coin \u2014 a stablecoin pegged 1:1 to the US dollar. Available on Solana as an SPL token.",
    category: "blockchain",
  },
  "commitment-level": {
    term: "commitment level",
    definition:
      'How finalized a transaction must be before the node considers it confirmed. Common levels: "processed" (fastest), "confirmed" (supermajority voted), "finalized" (irreversible).',
    category: "blockchain",
  },
  "transaction-signature": {
    term: "transaction signature",
    definition:
      "A unique base-58 encoded identifier for a submitted Solana transaction, produced by the signer\u2019s private key.",
    category: "blockchain",
  },
  jupiter: {
    term: "Jupiter",
    definition:
      "The leading DEX aggregator on Solana. Routes token swaps across multiple liquidity sources to find the best price.",
    category: "blockchain",
  },
  dex: {
    term: "DEX",
    definition:
      "Decentralized Exchange \u2014 a protocol that enables token trading directly on-chain without a centralized intermediary.",
    category: "blockchain",
  },
  slippage: {
    term: "slippage",
    definition:
      "The difference between the expected price of a swap and the actual executed price. Setting maxSlippage (e.g., 0.01 = 1%) protects against unfavorable price movement.",
    category: "blockchain",
  },
  "token-swap": {
    term: "token swap",
    definition:
      'An on-chain exchange of one token for another, routed through a DEX like Jupiter. In kova, this is an intent of type "swap".',
    category: "blockchain",
  },
  "spl-token": {
    term: "SPL token",
    definition:
      "Solana Program Library token \u2014 the standard for fungible and non-fungible tokens on Solana. USDC, for example, is an SPL token.",
    category: "blockchain",
  },
  "token-mint": {
    term: "token mint",
    definition:
      "The on-chain address that uniquely identifies an SPL token type. Each token (USDC, BONK, etc.) has a distinct mint address.",
    category: "blockchain",
  },
  lamports: {
    term: "lamports",
    definition:
      "The smallest unit of SOL. 1 SOL = 1,000,000,000 lamports. Named after computer scientist Leslie Lamport.",
    category: "blockchain",
  },

  // ── SDK Architecture ─────────────────────────────────────
  "transaction-intent": {
    term: "transaction intent",
    definition:
      'A declarative description of what an agent wants to do (e.g., "transfer 1 SOL to X"). The SDK evaluates it against policy rules before building and signing the actual transaction.',
    category: "sdk",
  },
  "policy-engine": {
    term: "policy engine",
    definition:
      "The core enforcement layer in kova. Evaluates an ordered list of policy rules against each transaction intent. If any rule denies, the transaction is blocked.",
    category: "sdk",
  },
  "policy-rule": {
    term: "policy rule",
    definition:
      "An individual constraint (e.g., spending limit, rate limit, allowlist) that the policy engine evaluates. Rules return ALLOW, DENY, or PENDING.",
    category: "sdk",
  },
  store: {
    term: "store",
    definition:
      "The persistence layer in kova. Holds spending counters, rate limit windows, circuit breaker state, and audit logs. MemoryStore for dev; SqliteStore for production.",
    category: "sdk",
  },
  signer: {
    term: "signer",
    definition:
      "A component that holds cryptographic keys and signs transactions. LocalSigner stores keys in memory (dev only); production should use hardware security modules.",
    category: "sdk",
  },
  "chain-adapter": {
    term: "chain adapter",
    definition:
      "Abstracts blockchain-specific logic: building transactions, broadcasting, querying balances, and validating addresses. SolanaAdapter is the current implementation.",
    category: "sdk",
  },
  "circuit-breaker": {
    term: "circuit breaker",
    definition:
      "A safety mechanism that halts all transactions after too many consecutive denials. Prevents a runaway agent from repeatedly hitting errors. Resets automatically after a cooldown period.",
    category: "sdk",
  },
  "audit-log": {
    term: "audit log",
    definition:
      "A tamper-evident record of every policy decision and transaction attempt. Entries are chained with SHA-256 hashes so any modification is detectable.",
    category: "sdk",
  },
  "hash-chain": {
    term: "hash chain",
    definition:
      "A sequence of records where each entry includes the cryptographic hash of the previous one. Used in kova\u2019s audit log to make tampering detectable.",
    category: "sdk",
  },
  idempotency: {
    term: "idempotency",
    definition:
      "The property that executing the same intent multiple times produces the same result. kova caches results by intent ID (24h TTL) to prevent duplicate transactions.",
    category: "sdk",
  },
  "fail-closed": {
    term: "fail-closed",
    definition:
      "A security design where failures result in DENY rather than ALLOW. If any kova component errors during evaluation, the transaction is blocked.",
    category: "sdk",
  },
  "human-in-the-loop": {
    term: "human-in-the-loop",
    definition:
      "A pattern where certain agent actions require explicit human approval before proceeding. In kova, implemented via the ApprovalGateRule and pluggable ApprovalChannel implementations (CallbackApprovalChannel, WebhookApprovalChannel).",
    category: "sdk",
  },
  allowlist: {
    term: "allowlist",
    definition:
      "A set of pre-approved recipient addresses. The AllowlistRule blocks transfers to any address not on the list.",
    category: "sdk",
  },
  denylist: {
    term: "denylist",
    definition:
      "A set of explicitly blocked addresses. Any address on this list is rejected regardless of other rules. Takes precedence over the allowlist.",
    category: "sdk",
  },
  "rolling-window": {
    term: "rolling window",
    definition:
      'A time-based counting strategy where limits apply to a sliding period (e.g., "last 60 seconds") rather than fixed calendar periods. Resets via TTL expiration.',
    category: "sdk",
  },
  ttl: {
    term: "TTL",
    definition:
      "Time To Live \u2014 how long a cached value remains valid before expiring. kova uses TTLs for spending counters, rate limits, and idempotency caches.",
    category: "sdk",
  },
  mutex: {
    term: "mutex",
    definition:
      "Mutual exclusion lock. kova serializes execute() calls through a mutex so only one transaction runs at a time, preventing race conditions on spending limits.",
    category: "sdk",
  },

  // ── AI / Tool Use ────────────────────────────────────────
  "tool-use": {
    term: "tool use",
    definition:
      "An AI capability where the model invokes structured functions (tools) during a conversation. kova provides wallet tools that Claude or GPT can call to check balances and execute transactions.",
    category: "ai",
  },
  "function-calling": {
    term: "function calling",
    definition:
      'The mechanism by which an LLM requests execution of a specific function with structured JSON arguments. OpenAI calls these "functions"; Anthropic calls them "tools".',
    category: "ai",
  },
  "system-prompt": {
    term: "system prompt",
    definition:
      "Instructions given to an LLM that define its behavior and constraints. In kova tutorials, the system prompt tells Claude what wallet operations are available.",
    category: "ai",
  },
  "multi-turn": {
    term: "multi-turn conversation",
    definition:
      "A back-and-forth exchange spanning multiple messages. Tool use often requires multi-turn flows: the model calls a tool, gets results, then responds.",
    category: "ai",
  },
  "tool-definitions": {
    term: "tool definitions",
    definition:
      "JSON schemas describing what tools an AI model can call, including parameter types and descriptions. kova generates these via toAnthropicTools() or toOpenAITools().",
    category: "ai",
  },
};
