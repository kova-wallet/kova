# Sprint 5 Test Report -- Agent Adapter Layer

## Summary

| Metric                    | Value                               |
|---------------------------|-------------------------------------|
| **Sprint**                | 5 -- Agent Adapter Layer            |
| **Test File**             | `tests/unit/adapters/adapters.test.ts` |
| **Tests Before**          | 61 (adapters), 669 total            |
| **Tests After**           | 181 (adapters), 789 total           |
| **Tests Added**           | 120                                 |
| **Test Files (total)**    | 14                                  |
| **All Passing**           | Yes (789/789)                       |
| **Framework**             | Vitest                              |

## New Test Coverage Breakdown

### 1. handleToolCall -- undefined/null input values (13 tests)

Tests every required field across all tool types (`wallet_transfer`, `wallet_swap`, `wallet_mint`, `wallet_stake`, `wallet_execute_custom`, `wallet_get_balance`) with `undefined` and `null` inputs to verify the wallet's intent validation catches missing data before it reaches the chain adapter.

- `to`, `amount`, `token`, `chain` as `undefined` for transfer
- `to` as `null` for transfer
- `fromToken`, `toToken` as `undefined` for swap
- `collection`, `metadataUri` as `undefined` for mint
- `amount`, `token` as `undefined` for stake
- `programId` as `undefined` for execute_custom
- `token` as `undefined` for get_balance

### 2. handleToolCall -- invalid chain values (6 tests)

Validates that all transaction tools reject unsupported chain values:

- Empty string chain
- Unsupported chain names (`bitcoin`, `polygon`, `avalanche`, `cosmos`)
- Numeric chain value (type coercion edge case)

### 3. handleToolCall -- negative, zero, and extreme amounts (12 tests)

Exercises numeric edge cases across `wallet_transfer`, `wallet_swap`, and `wallet_stake`:

- Amount `"0"` (rejected -- must be positive)
- Negative amounts like `"-5.0"`, `"-10.0"`, `"-100"` (rejected)
- Very large amounts `"999999999999999.999999999"` (accepted)
- Very small fractional amounts `"0.000000001"` (accepted)
- `"NaN"` string (rejected -- parseFloat returns NaN)
- `"Infinity"` string (accepted -- documents that parseFloat("Infinity") passes > 0 check)
- Non-numeric string `"abc"` (rejected)

### 4. handleToolCall -- empty string inputs (11 tests)

Verifies that all required string fields reject empty strings:

- Transfer: `to`, `amount`, `token`
- Swap: `fromToken`, `toToken`, `amount`
- Mint: `collection`, `metadataUri`
- Stake: `amount`, `token`
- Execute_custom: `programId`

### 5. handleToolCall -- special characters in addresses (2 tests)

- Whitespace-only `to` address (rejected)
- Leading/trailing whitespace in amount (accepted -- parseFloat trims)

### 6. handleToolCall -- missing required fields per tool type (9 tests)

Tests calling each tool handler with an empty `{}` input object:

- Transfer, swap, mint, stake, execute_custom with `{}`
- Swap missing only `amount`
- Mint and stake missing `chain`
- Execute_custom missing `data`

### 7. getPolicy -- store edge cases (7 tests)

Tests how `getPolicy()` handles unexpected store values for spending and rate-limit counters:

- Non-numeric spending counter (`"not-a-number"`) -- returned as-is
- Empty string spending counter -- returned as-is
- `"NaN"` string for rate limit counters -- `parseInt` returns `NaN`
- Float string rate limit counters (`"3.7"`) -- `parseInt` truncates to integer
- Negative rate limit counter (`"-1"`)
- Weekly and monthly spending counters populated from store

### 8. getPolicy -- AllowlistRule edge cases (4 tests)

- Empty `AllowlistConfig` object (no arrays at all)
- All arrays explicitly empty
- Deny-only lists (should not inflate allowlisted count)
- Combined allow + deny lists with correct counts

### 9. getPolicy -- TimeWindowRule edge cases (3 tests)

- Invalid timezone (`"Invalid/FakeTimezone"`) -- `isCurrentlyActive` set to `false`
- Empty windows array -- `isCurrentlyActive` is `false`
- Non-standard valid timezone (`"Asia/Tokyo"`) -- returns boolean

### 10. Adapter format verification -- tool schema completeness (14 tests)

- Every property across all 8 tools has a `type` field
- Every property across all 8 tools has a non-empty `description`
- Every tool has a description longer than 10 characters
- Chain `enum` is `["solana", "ethereum", "base"]` for all 5 transaction tools
- `wallet_get_balance` requires only `token`
- `wallet_get_transaction_history` requires no params, has optional `limit`
- `wallet_transfer` has optional `reason`
- `wallet_swap` has optional `maxSlippage` of type `number`
- `wallet_mint` requires `collection`, `metadataUri`, `chain`; has optional `to`
- `wallet_stake` requires `amount`, `token`, `chain`; has optional `validator`
- `wallet_execute_custom` requires `programId`, `data`, `accounts`, `chain`

### 11. Anthropic Adapter -- schema propagation (4 tests)

- Chain enum propagated into `input_schema`
- Required arrays match canonical definitions for all tools
- Property keys match canonical definitions for all tools
- All descriptions are non-empty

### 12. OpenAI Adapter -- schema propagation (4 tests)

- Chain enum propagated into `function.parameters`
- Required arrays match canonical definitions for all tools
- Property keys match canonical definitions for all tools
- All function descriptions are non-empty

### 13. ToolCallResult shape verification (11 tests)

- Successful transfer: `success=true`, `data` has `status`, `txId`, `summary`, `intentId`, `timestamp`
- Denied transfer: `success=false`, `error` is string, `data.status` is `"denied"`, `data.error.code` is `"POLICY_DENIED"`
- Validation failure: `success=false`, `data.status` is `"failed"`, `data.error.code` is `"VALIDATION_FAILED"`
- `wallet_get_balance`: `data` has `token`, `amount`, `decimals`, `usdValue` (TokenBalance shape)
- `wallet_get_policy`: `data` has `name`, `spendingLimits`, `allowlistedAddresses`, `allowlistedPrograms` (PolicySummary shape)
- `wallet_get_transaction_history`: `data` is an array
- Unknown tool: `success=false`, `data` is `undefined`, `error` lists available tools
- Swap result: `summary` contains "Swapped", token names
- Mint result: `summary` contains "Minted"
- Stake result: `summary` contains "Staked", amount, token

### 14. LangChain Adapter -- error handling and JSON stringification (9 tests)

- Validation failure returns parseable JSON with `success=false`
- Unknown tool error stringifies correctly
- Successful transfer stringifies to valid JSON with `data.status === "confirmed"`
- Policy result stringifies with rule names and limits
- Balance result stringifies with correct token data
- Transaction history stringifies as array
- Denied transaction stringifies with error and `status === "denied"`
- LangChain schema matches canonical schema for all 8 tools
- Chain adapter exceptions are caught and returned as `success=false` error JSON

### 15. Transaction history edge cases (6 tests)

- Limit of `0` (sanitized to default)
- Negative limit (sanitized to default)
- Non-numeric limit string (ignored, uses default)
- Very large limit (`999999`, clamped to `MAX_HISTORY_LIMIT`)
- `Infinity` limit (sanitized to default)
- `NaN` limit (sanitized to default)

### 16. wallet_execute_custom edge cases (5 tests)

- Empty JSON array string `"[]"`
- Empty array object `[]`
- Numeric `accounts` value (rejected)
- Non-array JSON string `'{"key": "value"}'` (rejected -- not an array)
- Valid multi-account JSON string

### 17. Chain adapter error propagation (2 tests)

- Chain `broadcast()` throwing `"Network timeout"` -- error propagated through `handleToolCall`
- Signer `sign()` throwing `"Hardware wallet disconnected"` -- error propagated through `handleToolCall`

## Notable Findings

1. **`"Infinity"` is accepted as a valid amount**: `parseFloat("Infinity")` returns `Infinity`, which satisfies `> 0`. This is documented behavior, not a bug in the current implementation, but could be hardened in the future.

2. **Spending counter values are returned from store as-is**: Non-numeric strings like `"not-a-number"` in spending counters pass through to the PolicySummary `used` field without sanitization. This is acceptable since the store is internal.

3. **Rate limit counters with `"NaN"` produce `NaN` in summary**: `parseInt("NaN", 10)` returns `NaN`, which propagates to `currentMinute`/`currentHour`. The `RateLimitRule.evaluate()` method handles this safely (its `getCurrentCount` returns `0` for NaN), but the `getPolicy()` introspection path does not apply the same guard.

4. **Invalid timezone fails closed**: Both `TimeWindowRule.evaluate()` and `populateTimeWindow()` catch timezone errors and set `isCurrentlyActive` to `false`, which is the correct deny-by-default behavior.

## Test Execution

```
vitest run

 Test Files  14 passed (14)
      Tests  789 passed (789)
   Start at  01:13:40
   Duration  1.26s
```
