# kova — Implementation Plan

**Goal**: Build a working, testable MVP that demonstrates a policy-constrained wallet an AI agent can use to transact on Solana.

**Target**: A developer can `npm install kova`, wire it into a Claude/GPT agent, configure a policy, and have the agent send SOL, swap tokens, and get Telegram approval for large transactions — all within 30 minutes.

---

## The Team

### Alex — Core SDK Architect
**Background**: 8 years TypeScript/Node.js. Built SDKs at Stripe and Twilio. Expert in API design, type systems, and developer experience.
**Owns**: AgentWallet core class, Transaction Intents, Policy builder API, Store interface, package structure, public API surface.
**Why hired**: The SDK's public API is the product. If the DX is bad, nobody uses it. Alex ensures every interface is clean, typed, minimal, and hard to misuse.

### Maya — Blockchain Engineer
**Background**: 4 years Solana development. Former core contributor to a Solana DeFi protocol. Deep knowledge of web3.js, SPL tokens, Jupiter, Metaplex, and transaction construction.
**Owns**: Solana chain adapter, transaction building, Jupiter swap integration, SPL token operations, RPC management, fee estimation.
**Why hired**: Solana has sharp edges — transaction size limits, compute budgets, versioned transactions, ATA management. Maya knows where the footguns are.

### Kai — Security Engineer
**Background**: 6 years in applied cryptography and wallet infrastructure. Previously at a custody provider. Specializes in key management, MPC protocols, and threat modeling.
**Owns**: Signer interface and implementations (local keypair, MPC prep), audit logging, policy enforcement hardening, security review of all code, fail-closed guarantees.
**Why hired**: This is a wallet. One bug in signing or policy enforcement can lose funds. Kai reviews every code path that touches keys or makes allow/deny decisions.

### Priya — Integration Engineer
**Background**: 5 years building bots, APIs, and LLM integrations. Built production Telegram/Slack bots and Claude tool-use integrations. Strong in async workflows and real-time systems.
**Owns**: Telegram approval bot, Claude adapter, OpenAI adapter, LangChain adapter, tool definitions, approval flow orchestration.
**Why hired**: The approval bot is a real-time, security-critical UX surface. The agent adapters must work perfectly with each LLM provider's idiosyncrasies. Priya has done both.

### Sam — QA & DevOps Engineer
**Background**: 5 years in testing infrastructure and CI/CD. Experience with monorepo tooling, integration testing, and release management.
**Owns**: Test infrastructure, unit/integration/e2e tests, CI pipeline, example demo agent, documentation, npm publish pipeline.
**Why hired**: A wallet SDK with bad tests is a liability. Sam ensures every policy rule, every edge case, and every failure mode is covered before anything ships.

---

## Project Structure

```
kova/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── whitepaper.md
├── IMPLEMENTATION_PLAN.md
│
├── src/
│   ├── index.ts                        # Public API exports
│   │
│   ├── core/
│   │   ├── wallet.ts                   # AgentWallet main class
│   │   ├── intent.ts                   # TransactionIntent types
│   │   └── result.ts                   # TransactionResult types
│   │
│   ├── policy/
│   │   ├── engine.ts                   # PolicyEngine — evaluates intents
│   │   ├── builder.ts                  # Policy.create() builder API
│   │   ├── types.ts                    # Policy types and interfaces
│   │   ├── rules/
│   │   │   ├── spending-limit.ts       # Spending limit rule
│   │   │   ├── allowlist.ts            # Address/program allowlist rule
│   │   │   ├── rate-limit.ts           # Rate limiting rule
│   │   │   ├── time-window.ts          # Time-based restriction rule
│   │   │   └── approval-gate.ts        # Human approval gate rule
│   │   └── serialization.ts            # Policy ↔ JSON
│   │
│   ├── signers/
│   │   ├── interface.ts                # Signer interface
│   │   ├── local.ts                    # LocalSigner (Keypair in memory)
│   │   └── mpc.ts                      # MPC signer (stub/interface for Phase 2)
│   │
│   ├── stores/
│   │   ├── interface.ts                # Store interface
│   │   ├── memory.ts                   # MemoryStore
│   │   └── sqlite.ts                   # SqliteStore
│   │
│   ├── chains/
│   │   ├── interface.ts                # ChainAdapter interface
│   │   └── solana/
│   │       ├── adapter.ts              # SolanaAdapter
│   │       ├── transfers.ts            # SOL and SPL token transfers
│   │       ├── swaps.ts                # Jupiter swap integration
│   │       └── utils.ts                # Address validation, ATA helpers
│   │
│   ├── approval/
│   │   ├── interface.ts                # ApprovalChannel interface
│   │   └── telegram.ts                 # TelegramApprovalBot
│   │
│   ├── adapters/
│   │   ├── claude.ts                   # Anthropic tool-use adapter
│   │   ├── openai.ts                   # OpenAI function-calling adapter
│   │   └── langchain.ts               # LangChain toolkit adapter
│   │
│   └── logging/
│       ├── audit.ts                    # Audit log manager
│       └── types.ts                    # AuditEntry types
│
├── tests/
│   ├── unit/
│   │   ├── policy/
│   │   │   ├── spending-limit.test.ts
│   │   │   ├── allowlist.test.ts
│   │   │   ├── rate-limit.test.ts
│   │   │   ├── time-window.test.ts
│   │   │   ├── approval-gate.test.ts
│   │   │   ├── engine.test.ts
│   │   │   └── builder.test.ts
│   │   ├── stores/
│   │   │   ├── memory.test.ts
│   │   │   └── sqlite.test.ts
│   │   ├── signers/
│   │   │   └── local.test.ts
│   │   └── core/
│   │       └── wallet.test.ts
│   ├── integration/
│   │   ├── solana-transfers.test.ts
│   │   ├── solana-swaps.test.ts
│   │   ├── policy-enforcement.test.ts
│   │   └── telegram-approval.test.ts
│   └── e2e/
│       └── agent-demo.test.ts
│
└── examples/
    ├── basic-transfer/                 # Simplest possible example
    │   └── index.ts
    ├── claude-agent/                   # Claude agent with wallet tools
    │   └── index.ts
    ├── policy-playground/              # Interactive policy testing
    │   └── index.ts
    └── telegram-approval/              # Full flow with Telegram approval
        └── index.ts
```

---

## Sprint Plan

### Sprint 0 — Project Bootstrap (Days 1–2)
**Goal**: Everyone can clone, build, and run tests.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S0-1 | Sam | Init repo: `package.json`, `tsconfig.json`, `vitest`, ESLint, Prettier | — |
| S0-2 | Sam | Set up CI pipeline (GitHub Actions: lint, typecheck, test on every PR) | S0-1 |
| S0-3 | Alex | Define all TypeScript interfaces in stub files (no implementation) | S0-1 |
| S0-4 | Alex | Write `src/index.ts` public API exports (what the user imports) | S0-3 |

**Deliverable**: Repo builds, types compile, CI runs green on empty test suite.

---

### Sprint 1 — Core Skeleton (Days 3–7)
**Goal**: The core data flow works end-to-end with stubs. An intent goes in, passes through policy (allow-all stub), gets "signed" (mock), and returns a result.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S1-1 | Alex | Implement `TransactionIntent` and `TransactionResult` types | S0-3 |
| S1-2 | Alex | Implement `AgentWallet` class — constructor, `execute()` method, wiring | S1-1 |
| S1-3 | Alex | Implement `Store` interface + `MemoryStore` | S0-3 |
| S1-4 | Kai | Implement `Signer` interface + `LocalSigner` (wraps Solana `Keypair`) | S0-3 |
| S1-5 | Maya | Implement `ChainAdapter` interface + `SolanaAdapter` stub (returns mock results) | S0-3 |
| S1-6 | Alex | Implement `PolicyEngine` — loads rules, evaluates sequentially, returns decision | S1-1 |
| S1-7 | Sam | Write unit tests for `MemoryStore`, `LocalSigner`, `AgentWallet` skeleton | S1-2, S1-3, S1-4 |

**Deliverable**: `wallet.execute(intent)` compiles and returns a mock result. All tests pass.

```typescript
// This should work at end of Sprint 1:
const wallet = new AgentWallet({
  signer: new LocalSigner(Keypair.generate()),
  chain: new SolanaAdapter({ rpcUrl: "..." }),   // returns mocks
  policy: Policy.create("test").build(),          // allow-all
  store: new MemoryStore(),
});

const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "...", amount: "1.0", token: "SOL" },
});
// result.status === "confirmed" (mocked)
```

---

### Sprint 2 — Policy Engine (Days 8–14)
**Goal**: All five policy rules work and are thoroughly tested.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S2-1 | Alex | Implement `Policy.create()` builder API with full chaining | S1-6 |
| S2-2 | Alex | Implement `Policy.toJSON()` / `Policy.fromJSON()` serialization | S2-1 |
| S2-3 | Alex | Implement `SpendingLimitRule` — per-tx, daily, weekly, monthly with store counters | S1-3, S1-6 |
| S2-4 | Alex | Implement `AllowlistRule` — address allowlist, program allowlist, denylist | S1-6 |
| S2-5 | Alex | Implement `RateLimitRule` — sliding window counter via store | S1-3, S1-6 |
| S2-6 | Alex | Implement `TimeWindowRule` — timezone-aware active hours check | S1-6 |
| S2-7 | Priya | Implement `ApprovalGateRule` — interface, pending state, callback mechanism | S1-6 |
| S2-8 | Kai | Review all policy rules for bypass vulnerabilities. Write adversarial tests | S2-3 through S2-7 |
| S2-9 | Sam | Write comprehensive unit tests for every rule (happy path + edge cases) | S2-3 through S2-7 |
| S2-10 | Sam | Write policy engine integration test — all rules combined, evaluation order | S2-3 through S2-7 |

**Deliverable**: Policy engine is fully functional. 100+ tests covering all rules.

```typescript
// This should work at end of Sprint 2:
const policy = Policy.create("demo")
  .spendingLimit({ perTransaction: { amount: "1", token: "SOL" }, daily: { amount: "5", token: "SOL" } })
  .allowAddresses(["addr1...", "addr2..."])
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .activeHours({ timezone: "UTC", windows: [{ days: ["mon","tue","wed","thu","fri"], start: "09:00", end: "17:00" }] })
  .requireApproval({ above: { amount: "2", token: "SOL" } })
  .build();

const json = policy.toJSON();   // serializable
const loaded = Policy.fromJSON(json);  // round-trips
```

---

### Sprint 3 — Solana Chain Adapter (Days 15–21)
**Goal**: Real Solana transactions work on devnet.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S3-1 | Maya | Implement SOL transfer (System Program) in `SolanaAdapter` | S1-5 |
| S3-2 | Maya | Implement SPL token transfer with auto ATA creation | S3-1 |
| S3-3 | Maya | Implement Jupiter swap integration (quote + execute) | S3-1 |
| S3-4 | Maya | Implement balance queries (SOL + SPL tokens) | S3-1 |
| S3-5 | Maya | Implement transaction status polling and confirmation | S3-1 |
| S3-6 | Maya | Implement priority fee estimation and compute budget | S3-1 |
| S3-7 | Maya | Implement address validation and error handling | S3-1 |
| S3-8 | Kai | Implement value normalization (token amounts → USD via Jupiter price API) for spending limits | S3-3 |
| S3-9 | Alex | Implement `SqliteStore` for persistent state | S1-3 |
| S3-10 | Sam | Write devnet integration tests: transfer SOL, transfer SPL, swap via Jupiter | S3-1 through S3-5 |

**Deliverable**: Agent can send SOL, send USDC, swap SOL→USDC on Solana devnet. Real transactions on a real chain.

```typescript
// This should work at end of Sprint 3 (on devnet):
const wallet = new AgentWallet({
  signer: new LocalSigner(devnetKeypair),
  chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }),
  policy: Policy.create("devnet-test").spendingLimit({ daily: { amount: "2", token: "SOL" } }).build(),
  store: new MemoryStore(),
});

const balance = await wallet.getBalance("SOL");
// balance: { amount: "5.0", token: "SOL" }

const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "recipient...", amount: "0.1", token: "SOL" },
});
// result.txId: "5K8v..." (real devnet transaction)
```

---

### Sprint 4 — Telegram Bot + Approval Flow (Days 22–28)
**Goal**: Human can approve/reject transactions from Telegram.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S4-1 | Priya | Set up Telegram bot via BotFather, implement bot framework (grammY or telegraf) | — |
| S4-2 | Priya | Implement `ApprovalChannel` interface | S2-7 |
| S4-3 | Priya | Implement `TelegramApprovalBot` — sends approval request with inline buttons | S4-1, S4-2 |
| S4-4 | Priya | Implement callback handler — Approve / Reject button handling | S4-3 |
| S4-5 | Priya | Implement timeout logic — auto-reject after configurable duration | S4-3 |
| S4-6 | Priya | Implement rich notification formatting (amount, recipient, budget context, reason) | S4-3 |
| S4-7 | Kai | Implement bot security — user ID validation, rate limiting, confirmation codes for large amounts | S4-3 |
| S4-8 | Priya | Wire `ApprovalGateRule` to `TelegramApprovalBot` in the policy engine | S4-4, S2-7 |
| S4-9 | Sam | Write integration tests: approval flow (mock Telegram API), timeout flow, reject flow | S4-8 |
| S4-10 | Sam | Manual QA: test full flow with real Telegram bot on devnet | S4-8, S3-10 |

**Deliverable**: Transactions above threshold trigger Telegram notification. Human taps Approve → tx executes. Human taps Reject → agent gets denial. Timeout → auto-reject.

---

### Sprint 5 — Agent Adapters (Days 29–35)
**Goal**: Claude, OpenAI, and LangChain agents can use the wallet as a tool.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S5-1 | Priya | Define canonical tool schemas for all wallet operations | S1-1 |
| S5-2 | Priya | Implement `wallet.toAnthropicTools()` — converts to Claude tool format | S5-1 |
| S5-3 | Priya | Implement `wallet.toOpenAITools()` — converts to OpenAI function format | S5-1 |
| S5-4 | Priya | Implement `wallet.handleToolCall(name, input)` — dispatches tool calls to wallet methods | S5-1 |
| S5-5 | Priya | Implement `WalletToolkit` for LangChain — wraps wallet as LangChain tools | S5-1, S5-4 |
| S5-6 | Priya | Implement `wallet.getPolicy()` tool — agent can introspect its constraints | S2-1 |
| S5-7 | Priya | Implement `wallet.getTransactionHistory()` tool | S1-3 |
| S5-8 | Sam | Write unit tests for all adapters (schema validation, tool call dispatch) | S5-2 through S5-5 |

**Deliverable**: Any Claude/GPT/LangChain agent can use kova by adding tools to their context.

```typescript
// Claude example at end of Sprint 5:
const wallet = new AgentWallet({ /* ... */ });

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5-20250929",
  tools: wallet.toAnthropicTools(),
  messages: [{ role: "user", content: "Send 0.5 SOL to Alice for the data analysis work" }],
});

for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
    // Feed result back to Claude
  }
}
```

---

### Sprint 6 — Audit Logging + Security Hardening (Days 36–42)
**Goal**: Every action is logged. All failure modes fail closed. Security review complete.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S6-1 | Kai | Implement `AuditLogger` — structured logging of every policy decision and transaction | S1-2 |
| S6-2 | Kai | Implement circuit breaker — N consecutive denials → cooldown period | S1-6 |
| S6-3 | Kai | Verify fail-closed behavior: store down, RPC down, signer down, oracle down | S3-8 |
| S6-4 | Kai | Full security review of `AgentWallet` — ensure no public method exposes signer/store/policy internals | S1-2 |
| S6-5 | Kai | Full security review of `PolicyEngine` — ensure no evaluation path skips a rule | S2-3 through S2-7 |
| S6-6 | Kai | Full security review of `SolanaAdapter` — ensure intent-to-transaction mapping cannot be manipulated | S3-1 through S3-7 |
| S6-7 | Kai | Write adversarial test suite: prompt injection scenarios, policy bypass attempts, race conditions | S6-3 through S6-6 |
| S6-8 | Sam | Write failure mode tests: every row in the failure mode table from the whitepaper | S6-3 |

**Deliverable**: Complete audit log for every wallet action. Adversarial test suite passes. No known bypass vectors.

---

### Sprint 7 — Examples, Docs, Polish (Days 43–49)
**Goal**: A developer can use kova from reading the README alone.

| Task | Owner | Description | Depends on |
|------|-------|-------------|------------|
| S7-1 | Sam | Write `examples/basic-transfer/` — simplest possible send SOL example | all sprints |
| S7-2 | Sam | Write `examples/claude-agent/` — Claude agent that can pay for services | S5-2 |
| S7-3 | Sam | Write `examples/policy-playground/` — interactive CLI to test policies | S2-1 |
| S7-4 | Sam | Write `examples/telegram-approval/` — full flow with Telegram | S4-8 |
| S7-5 | Alex | Write README.md — quickstart, installation, core concepts, API reference | all sprints |
| S7-6 | Alex | Review and clean all public API types — ensure consistency, naming, JSDoc | all sprints |
| S7-7 | Sam | Set up npm publish pipeline (changeset, version, publish) | S0-2 |
| S7-8 | All | Internal dogfooding — each engineer builds a different agent and tries to break it | all sprints |
| S7-9 | Sam | Write e2e test: Claude agent + devnet + Telegram approval, full automated run | all sprints |

**Deliverable**: `npm install kova` works. README gets a developer to a working agent in <30 minutes. Four working examples.

---

## Dependency Graph

```
Sprint 0 (Bootstrap)
   │
   ▼
Sprint 1 (Core Skeleton) ──────────────────────────────┐
   │                                                    │
   ├──────────────┐                                     │
   ▼              ▼                                     │
Sprint 2       Sprint 3                                 │
(Policy)       (Solana Adapter)                         │
   │              │                                     │
   ├──────┬───────┘                                     │
   ▼      │                                             │
Sprint 4  │     Sprint 5 ◀─────────────────────────────┘
(Telegram) │    (Agent Adapters)
   │       │       │
   └───┬───┘───────┘
       ▼
Sprint 6 (Security Hardening)
       │
       ▼
Sprint 7 (Examples, Docs, Ship)
```

**Key parallelism**: Sprints 2 (Policy) and 3 (Solana) run **in parallel** — Alex builds the policy engine while Maya builds the chain adapter. They share only the interfaces defined in Sprint 1. Sprint 5 (Agent Adapters) can start in parallel with Sprint 4 since it only depends on Sprint 1 interfaces and Sprint 2 policy introspection.

---

## Milestones

| Milestone | Sprint | Date (from kickoff) | Definition of Done |
|-----------|--------|--------------------|--------------------|
| **M0: Repo Ready** | 0 | Day 2 | Repo builds, CI green, all interfaces defined |
| **M1: Skeleton E2E** | 1 | Day 7 | `wallet.execute()` works with mocks |
| **M2: Policy Complete** | 2 | Day 14 | All 5 policy rules work, 100+ tests pass |
| **M3: Real Transactions** | 3 | Day 21 | SOL transfer, token transfer, and swap work on devnet |
| **M4: Human in the Loop** | 4 | Day 28 | Telegram approval flow works end-to-end |
| **M5: Agent Ready** | 5 | Day 35 | Claude agent can use wallet as tool |
| **M6: Security Signed Off** | 6 | Day 42 | Kai signs off on security review, adversarial tests pass |
| **M7: Ship It** | 7 | Day 49 | npm published, README done, 4 examples work |

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation | Owner |
|------|--------|------------|------------|-------|
| Jupiter API changes or rate limits | Can't swap tokens | Medium | Abstract Jupiter behind interface, have fallback to direct Raydium | Maya |
| Solana devnet instability | Integration tests flaky | High | Use local validator (`solana-test-validator`) for CI, devnet for manual QA | Sam |
| Policy race conditions | Spending limits bypassable | Medium | Atomic store operations, adversarial concurrency tests | Kai |
| Telegram API downtime | Approvals blocked | Low | Fail closed (deny), alert wallet owner, configurable fallback to CLI approval | Priya |
| LLM tool-calling format changes | Agent adapters break | Low | Pin SDK versions, abstract behind adapter layer | Priya |
| Scope creep (EVM, tokens, dashboard) | MVP delayed | High | Strict scope: Solana only for MVP. EVM is Phase 3. Say no to everything else. | Alex |

---

## Definition of "Working Product We Can Test"

At the end of Sprint 7, we can run this demo:

```typescript
import { AgentWallet, Policy, LocalSigner, SolanaAdapter,
         MemoryStore, TelegramApprovalBot } from "kova";
import Anthropic from "@anthropic-ai/sdk";

// 1. Set up a constrained wallet
const wallet = new AgentWallet({
  signer: new LocalSigner(myKeypair),
  chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }),
  store: new MemoryStore(),
  policy: Policy.create("demo-agent")
    .spendingLimit({ perTransaction: { amount: "0.5", token: "SOL" }, daily: { amount: "2", token: "SOL" } })
    .allowAddresses(["serviceProvider...", "dataVendor..."])
    .rateLimit({ maxTransactionsPerMinute: 3 })
    .requireApproval({
      above: { amount: "0.3", token: "SOL" },
      channel: "telegram",
      timeout: 300_000,
    })
    .build(),
  approval: new TelegramApprovalBot({
    token: process.env.TELEGRAM_BOT_TOKEN!,
    chatId: process.env.TELEGRAM_CHAT_ID!,
  }),
});

// 2. Give the wallet to a Claude agent
const client = new Anthropic();
const tools = wallet.toAnthropicTools();

const response = await client.messages.create({
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  system: "You are an assistant that can make payments. Check your policy limits before transacting.",
  tools,
  messages: [{ role: "user", content: "Pay 0.1 SOL to serviceProvider... for the API access" }],
});

// 3. Handle the tool call
for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
    console.log(result);
    // { status: "confirmed", txId: "5K8v...", summary: "Sent 0.1 SOL to serviceProvider..." }
  }
}

// 4. Try a large payment → triggers Telegram approval
// "Pay 0.4 SOL to dataVendor..." → Your phone buzzes with an approval request
```

**This is the "it works" moment.** A real agent, real policy enforcement, real Solana transactions, real human approval on Telegram.

---

## What's NOT in the MVP

These are explicitly deferred to avoid scope creep:

- EVM / multi-chain support (Phase 3)
- MPC signer implementation (Phase 2 — interface is ready)
- TEE / enclave signer (Phase 4)
- Web dashboard for policy management
- Token economics
- NFT minting operations (chain adapter supports it, but not tested/documented in MVP)
- Redis store (Phase 2)
- Slack / email approval channels
- Agent reputation scoring
- Onchain policy verification
- Cross-chain operations
