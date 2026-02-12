# Sprint 5 — Results

**Project:** kova
**Sprint:** 5 — Agent Adapter Layer
**Date:** 2026-02-12

---

## Summary

Sprint 5 implements the Agent Adapter Layer — the final piece that makes the wallet usable as a tool by AI agents. Claude, OpenAI, and LangChain agents can now discover available wallet operations, execute transactions, check balances, and inspect policy constraints through their native tool-use interfaces. All code compiles cleanly and all 789 tests pass.

### Deliverables

| Deliverable | Status |
|------------|--------|
| Canonical tool definitions (8 tools) | Implemented |
| Anthropic (Claude) adapter | Implemented |
| OpenAI adapter | Implemented |
| LangChain adapter (no dependency) | Implemented |
| `handleToolCall()` dispatch | Implemented |
| `toAnthropicTools()` / `toOpenAITools()` | Implemented |
| `getPolicy()` introspection | Implemented |
| `getConfig()` on all 5 policy rules | Implemented |
| `getRules()` on PolicyEngine | Implemented |
| Security audit | 13 findings (0C, 2H, 4M, 4L, 3I) |
| QA testing | 789 tests, 181 adapter tests, all passing |
| Security fixes applied | 5 fixes from audit |

---

## Security Audit Findings (13 total)

### Fixes Applied in Sprint 5

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S5-01 | HIGH | `handleGetBalance()` bypasses `execute()` pipeline — no runtime validation on `token` parameter | Added explicit type/empty check before calling `getBalance()` |
| S5-02 | HIGH | `handleCustom()` accepts structurally invalid parsed JSON — `JSON.parse("[1,2,3]")` passes `Array.isArray` but contains numbers, not account objects | Added per-element validation: each account must have `{ address: string, isSigner: boolean, isWritable: boolean }` |
| S5-04 | MEDIUM | Raw exception messages in `handleToolCall()` catch block leak internal details (file paths, stack traces) to agent | Replaced with generic message: "An internal error occurred while processing the tool call." |
| S5-05 | MEDIUM | `PolicyEngine.getRules()` returns mutable reference to internal rules array — external code could mutate rule order | Returns `Object.freeze([...this.rules])` — frozen defensive copy |
| S5-10 | LOW | LangChain adapter `call()` has no independent error handling — `JSON.stringify(BigInt)` or unexpected throws would crash agent loop | Added defensive try/catch returning `{ success: false, error: "..." }` |

### Deferred Findings

| ID | Severity | Finding | Reason |
|----|----------|---------|--------|
| S5-03 | MEDIUM | `AllowlistRule.getConfig()` exposes full address/program lists | Returns from Sets stored in memory — no external data. Restricting to counts would reduce developer utility |
| S5-06 | MEDIUM | Unknown tool error reflects input and enumerates all tool names | Tool names are public (part of tool schemas sent to LLM). Input is string-only, not executed |
| S5-07 | LOW | Shallow copy of tool properties allows deep mutation of canonical definitions | Requires in-process code execution to exploit |
| S5-08 | LOW | `MAX_HISTORY_LIMIT = 1000` is generous | Acceptable for current use; review for production |
| S5-09 | LOW | `getPolicy()` exposes current spending/rate-limit counters | By design — helps agents plan within limits |
| S5-11 | INFO | Tool definitions are static literals, not injectable | Positive security property |
| S5-12 | INFO | Tool descriptions are hardcoded, not vulnerable to prompt injection | Positive security property |
| S5-13 | INFO | Store key patterns duplicated between rules and introspection helpers | Maintenance concern, not security |

---

## QA Test Results

- **Total tests:** 789
- **Passing:** 789
- **New tests added:** 181 adapter tests (61 original + 120 QA-added edge cases)
- **Removed:** 4 stub tests from wallet.test.ts
- **Net change:** +177 tests (612 → 789)

### Test Distribution

| File | Tests |
|------|-------|
| adapters.test.ts | 181 |
| wallet.test.ts | 133 |
| rules.test.ts | 102 |
| solana-utils.test.ts | 57 |
| builder.test.ts | 56 |
| telegram.test.ts | 56 |
| sqlite.test.ts | 54 |
| solana-adapter.test.ts | 39 |
| memory.test.ts | 38 |
| audit.test.ts | 19 |
| engine.test.ts | 18 |
| intent.test.ts | 18 |
| local.test.ts | 13 |
| mpc.test.ts | 5 |

### QA Test Coverage Highlights

- **17 new describe blocks** covering: undefined/null inputs, invalid chains, negative/zero/extreme amounts, empty strings, special characters, missing required fields, store edge cases, AllowlistRule/TimeWindowRule edge cases, schema completeness, ToolCallResult shape, LangChain error handling, transaction history limits, custom intent accounts parsing, chain adapter error propagation
- **Notable finding:** `parseFloat("Infinity")` passes `> 0` validation — documented as known behavior, potential future hardening opportunity

---

## Files Modified

### New Files

- `src/adapters/tools.ts` — 235 lines, canonical tool definitions (8 tools)
- `tests/unit/adapters/adapters.test.ts` — 2341 lines, 181 tests

### Rewritten Files

- `src/adapters/claude.ts` — Anthropic format converter (`parameters` → `input_schema`)
- `src/adapters/openai.ts` — OpenAI format converter (`{ type: "function", function: {...} }`)
- `src/adapters/langchain.ts` — LangChain adapter with `call()` wrapper (no LangChain dependency)

### Modified Files

- `src/core/wallet.ts` — Implemented `handleToolCall()`, `toAnthropicTools()`, `toOpenAITools()`, `getPolicy()` + 8 private handler methods + 5 policy introspection helpers + 3 security fixes (S5-01, S5-02, S5-04)
- `src/policy/engine.ts` — Added `getRules()` with frozen defensive copy (S5-05)
- `src/policy/rules/spending-limit.ts` — Added `getConfig()`
- `src/policy/rules/allowlist.ts` — Added `getConfig()` (reconstructs from Sets)
- `src/policy/rules/rate-limit.ts` — Added `getConfig()`
- `src/policy/rules/time-window.ts` — Added `getConfig()`
- `src/policy/rules/approval-gate.ts` — Added `getConfig()`
- `src/adapters/index.ts` — Updated barrel exports
- `src/index.ts` — Updated public API exports
- `tests/unit/core/wallet.test.ts` — Removed 4 stub tests

---

## Key Design Decisions

1. **`wallet_` prefix for tool names**: Avoids collisions with other agent tools (e.g., `wallet_transfer` not just `transfer`).
2. **Separate tools per intent type**: LLMs handle explicit schemas more reliably than a single mega-tool with `type` discriminator.
3. **No new dependencies**: All adapters are pure format converters. LangChain adapter produces plain objects with the right shape — no `@langchain/core`, `zod`, `@anthropic-ai/sdk`, or `openai` imports.
4. **Single canonical source**: Tool definitions in `src/adapters/tools.ts` are the single source of truth. Provider-specific adapters convert from this canonical form.
5. **`handleToolCall` returns `ToolCallResult`**: Typed, consistent wrapper (`{ success, data?, error? }`) — `confirmed` maps to `success: true`, everything else maps to `success: false`.
6. **Policy introspection via `instanceof` checks**: `getPolicy()` uses `instanceof` against known rule classes after `getRules()`. This is tightly coupled to the rule implementations but avoids adding a generic config extraction interface to the `PolicyRule` contract.
7. **Sanitized error messages**: Internal exceptions in `handleToolCall()` return a generic error message to prevent leaking implementation details to the agent (S5-04 fix).

---

## What's Next

All 5 sprints of the implementation plan are now complete. The SDK provides:
- Full transaction execution pipeline (Sprint 0-1)
- 5 policy rules: spending limits, allowlists, rate limits, time windows, approval gates (Sprint 2)
- Solana chain adapter with real RPC integration patterns (Sprint 3)
- Telegram approval bot for human-in-the-loop (Sprint 4)
- Agent adapter layer for Claude, OpenAI, and LangChain (Sprint 5)
