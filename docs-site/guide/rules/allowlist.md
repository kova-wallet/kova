# AllowlistRule

::: info What you'll learn
- How to restrict which addresses and programs your agent can interact with
- The evaluation precedence: deny lists always take priority over allow lists
- How EVM address normalization prevents case-based bypasses
- How to combine allow and deny lists for layered security
- How different intent types extract their target addresses
:::

`AllowlistRule` controls who your AI agent can send money to -- like a contacts list on a bank account that blocks transfers to anyone not on the list.

The `AllowlistRule` restricts which addresses and programs the agent can interact with. It supports both allowlists (whitelist) and denylists (blacklist) for addresses and program IDs.

## When to Use This

- **Restrict recipients to known addresses**: Use `AllowlistRule` when your agent should only send funds to a specific set of pre-approved wallets (e.g., your treasury, a vendor, a payment processor).
- **Block known bad actors**: Add scam addresses or malicious programs to a denylist so your agent can never interact with them, even if instructed to.
- **Limit which smart contracts the agent can call**: If your agent executes on-chain programs (smart contracts), restrict it to only the programs you have reviewed and trust.

## How It Works

Every time your agent tries to send a transaction, `AllowlistRule` checks the destination:

1. **Is the recipient on the block list?** If yes, the transaction is denied immediately.
2. **Is there an approved-only list configured?** If yes, the recipient must be on that list, or the transaction is denied.
3. **Is the program (smart contract) on the block list?** If yes, denied.
4. **Is there an approved programs list?** If yes, the program must be on it.
5. If all checks pass, the transaction is allowed.

The key principle: **deny lists always win**. An address that appears on both the allow and deny list will be denied.

::: tip WHAT ARE "ADDRESSES" AND "PROGRAMS"?
An **address** is like a bank account number -- it identifies where to send funds. In blockchain, addresses are long strings of characters (e.g., `9WzDXwBb...`). A **program** (also called a "smart contract") is code that runs on the blockchain. When your agent interacts with a decentralized app (like a token exchange), it is calling a program at a specific address.
:::

## Decision Table

| Scenario | allowAddresses | denyAddresses | Target Address | Result |
|---|---|---|---|---|
| Address is on the allow list | `["Alice", "Bob"]` | -- | `"Alice"` | **ALLOW** |
| Address is NOT on the allow list | `["Alice", "Bob"]` | -- | `"Eve"` | **DENY** |
| Address is on the deny list | -- | `["Eve"]` | `"Eve"` | **DENY** |
| Address is NOT on the deny list, no allow list | -- | `["Eve"]` | `"Alice"` | **ALLOW** |
| No allow or deny lists configured | -- | -- | `"Anyone"` | **ALLOW** |
| Address on BOTH lists | `["Eve"]` | `["Eve"]` | `"Eve"` | **DENY** (deny wins) |

## Import

```typescript
// Import the AllowlistRule class, which controls which addresses and programs
// the agent is permitted to interact with.
import { AllowlistRule } from "kova";
```

## AllowlistConfig

```typescript
// Configuration for the AllowlistRule.
// All fields are optional — configure the combination that fits your security requirements.
// You can use allowlists (only these are permitted), denylists (these are blocked),
// or both (deny takes precedence over allow).
interface AllowlistConfig {
  /** Addresses the agent IS allowed to send to */
  allowAddresses?: string[];
  /** Addresses the agent is NEVER allowed to send to */
  denyAddresses?: string[];
  /** Program IDs the agent IS allowed to interact with */
  allowPrograms?: string[];
  /** Program IDs the agent is NEVER allowed to interact with */
  denyPrograms?: string[];
}
```

All fields are optional. Configure the combination that fits your security requirements.

## Constructor

```typescript
// Create an AllowlistRule with both an allowlist and a denylist.
// - allowAddresses: only these two Solana addresses can receive transfers.
//   Any transfer to an address NOT in this list is denied.
// - denyAddresses: this address is explicitly blocked, even if it were somehow
//   added to the allow list (deny always takes precedence).
// Internally, the rule stores these in Set objects for O(1) constant-time lookups.
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",  // First approved address
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",  // Second approved address
  ],
  denyAddresses: [
    "ScamAddress111111111111111111111111111111111",     // Known malicious address — always blocked
  ],
});
```

The constructor takes only an `AllowlistConfig` object. Internally, addresses are stored in `Set` objects for O(1) lookup.

## Evaluation Precedence

The rule evaluates in a strict order. **Deny lists are always checked first.**

```
1. Is the target address in denyAddresses?     → YES → DENY
2. Is allowAddresses configured?
   └─ Is the target address in allowAddresses?  → NO  → DENY
3. Is the programId in denyPrograms?            → YES → DENY
4. Is allowPrograms configured?
   └─ Is the programId in allowPrograms?        → NO  → DENY
5. All checks passed                            → ALLOW
```

Key behaviors:

- **Deny lists take precedence** over allow lists. An address in both `denyAddresses` and `allowAddresses` will be denied.
- **If no allow list is configured**, all non-denied addresses/programs are allowed. The rule only filters what is explicitly denied.
- **If an allow list is configured**, ONLY addresses/programs in the list are allowed. Everything else is denied.

::: warning
Configuring an `allowAddresses` list means ALL addresses not on that list will be blocked. If you only want to block a few known-bad addresses, use `denyAddresses` alone instead.
:::

## EVM Address Normalization

The `AllowlistRule` automatically normalizes EVM addresses (0x-prefixed, 42 characters) to lowercase for case-insensitive matching. This prevents bypasses caused by EIP-55 mixed-case checksummed addresses:

::: tip WHAT IS AN EVM ADDRESS?
EVM (Ethereum Virtual Machine) addresses are used on Ethereum and compatible blockchains. They look like `0xdAC17F958D2ee523a2206206994597C13D831ec7` -- always starting with `0x` followed by 40 hexadecimal characters. Unlike Solana addresses, EVM addresses can be written in different cases (upper, lower, mixed) but still refer to the same account. The rule normalizes these to prevent case-based bypasses.
:::

```typescript
// Create an allowlist with an EVM (Ethereum) address.
// EVM addresses use mixed-case checksums (EIP-55), but the rule normalizes
// all EVM addresses to lowercase internally to prevent case-based bypasses.
const rule = new AllowlistRule({
  allowAddresses: [
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT contract on Ethereum (mixed-case EIP-55 checksum)
  ],
});

// All of these will match because EVM addresses are compared case-insensitively:
// "0xdac17f958d2ee523a2206206994597c13d831ec7"  (all lowercase)
// "0xDAC17F958D2EE523A2206206994597C13D831EC7"  (all uppercase)
// The rule detects EVM addresses by the 0x prefix and 42-character length.
```

Solana addresses use base58 encoding which is case-sensitive, so Solana addresses are stored and compared as-is.

## Address Extraction

The rule extracts target addresses from intents based on intent type:

| Intent Type | Address Field | Plain-English Description |
|-------------|---------------|--------------------------|
| `transfer` | `params.to` | The recipient of a token transfer |
| `custom` | `params.programId` | The smart contract being called |
| `mint` | `params.collection` | The NFT collection being minted from |
| `stake` | `params.validator` | The validator node receiving the stake |
| `swap` | No target address (passes through) | Token swaps route through a DEX aggregator, not a specific address |

If no target address can be extracted (e.g., swap intents), the address check is skipped.

## Code Examples

### Transfer Allowlist

Only allow the agent to send funds to known, vetted addresses:

```typescript
// Create a strict transfer allowlist.
// Only these three pre-approved Solana addresses can receive funds from the agent.
// Any attempt to transfer to an address NOT in this list results in DENY.
// This is the most common security pattern — it limits the "blast radius" of a compromised agent.
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Treasury wallet
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH", // Vendor payment address
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Payment processor address
  ],
});
```

Result: Transfers to any address NOT in this list will be denied.

### Program Allowlist

Restrict which Solana programs the agent can interact with:

::: tip WHAT IS A SOLANA PROGRAM?
A Solana "program" is equivalent to a "smart contract" on Ethereum. It is a piece of code deployed on the blockchain that performs specific operations (e.g., transferring tokens, executing swaps). Each program has a unique ID (address). By allowlisting specific program IDs, you ensure your agent only interacts with known, audited code.
:::

```typescript
// Create a program allowlist for custom intents.
// Only these three Solana programs can be targeted by custom instructions.
// This prevents the agent from interacting with unknown or malicious programs.
const rule = new AllowlistRule({
  allowPrograms: [
    "11111111111111111111111111111111",                 // Solana System Program (native SOL transfers, account creation)
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",    // SPL Token Program (token transfers, minting, burning)
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter aggregator (DEX swaps)
  ],
});
```

Result: Custom intents targeting any program NOT in this list will be denied.

### Deny List

Block specific known-bad addresses without restricting everything else:

```typescript
// Create a denylist-only rule (no allowlist).
// When no allowAddresses/allowPrograms are configured, ALL addresses and programs
// are allowed EXCEPT those explicitly in the deny lists.
// Use this when you want an open policy but need to block specific known threats.
const rule = new AllowlistRule({
  denyAddresses: [
    "ScamAddress111111111111111111111111111111111",     // Known scam wallet
    "DrainerBot22222222222222222222222222222222222",    // Known drainer bot
  ],
  denyPrograms: [
    "MaliciousProgram3333333333333333333333333333",     // Known malicious program
  ],
});
```

Result: These addresses and programs are always blocked. All other addresses and programs are allowed.

### Combined Allow + Deny Lists

```typescript
// Combine an address allowlist with a program denylist.
// - allowAddresses: only these two addresses can receive transfers.
// - denyPrograms: this program is blocked for custom intents.
// - Since allowPrograms is NOT set, all programs (except denied ones) are allowed for custom intents.
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",  // Approved recipient 1
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",  // Approved recipient 2
  ],
  denyPrograms: [
    "MaliciousProgram3333333333333333333333333333",     // Blocked malicious program
  ],
});
```

Result: Only the two allowlisted addresses can receive transfers. The malicious program is additionally blocked for custom intents. Other programs are allowed (since `allowPrograms` is not set).

::: warning
The `Policy` builder validates that no address or program appears in both the allow and deny lists. If there is overlap, `build()` throws an error.
:::

## Denial Messages

When an address or program is denied, the rule returns descriptive messages:

```
DENY: Address is denylisted: ScamAddress1111...
DENY: Address is not in the allowlist: UnknownAddr2222...
DENY: Program is denylisted: MaliciousProgram3333...
DENY: Program is not in the allowlist: RandomProgram4444...
```

## Introspection

```typescript
// Retrieve the rule's configuration for inspection or logging.
// Returns copies of the internal lists — mutating the returned arrays
// does NOT affect the rule's behavior (defensive copy).
const config = rule.getConfig();
console.log("Allowed addresses:", config.allowAddresses);   // Array of allowed address strings (or undefined)
console.log("Denied addresses:", config.denyAddresses);     // Array of denied address strings (or undefined)
console.log("Allowed programs:", config.allowPrograms);     // Array of allowed program ID strings (or undefined)
console.log("Denied programs:", config.denyPrograms);       // Array of denied program ID strings (or undefined)
```

`getConfig()` returns copies of the lists. Mutating the returned arrays does not affect the rule.

## See Also

- [SpendingLimitRule](/guide/rules/spending-limit) -- caps how much the agent can spend (use alongside allowlists for defense-in-depth)
- [RateLimitRule](/guide/rules/rate-limit) -- limits how many transactions per time window
- [ApprovalGateRule](/guide/rules/approval-gate) -- requires human approval for high-value transactions
- [TimeWindowRule](/guide/rules/time-window) -- restricts when the agent can transact
