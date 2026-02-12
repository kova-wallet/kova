# AllowlistRule

The `AllowlistRule` restricts which addresses and programs the agent can interact with. It supports both allowlists (whitelist) and denylists (blacklist) for addresses and program IDs.

## Import

```typescript
import { AllowlistRule } from "kova";
```

## AllowlistConfig

```typescript
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
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ],
  denyAddresses: [
    "ScamAddress111111111111111111111111111111111",
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

## EVM Address Normalization

The `AllowlistRule` automatically normalizes EVM addresses (0x-prefixed, 42 characters) to lowercase for case-insensitive matching. This prevents bypasses caused by EIP-55 mixed-case checksummed addresses:

```typescript
const rule = new AllowlistRule({
  allowAddresses: [
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT on Ethereum
  ],
});

// All of these will match (case-insensitive for EVM):
// "0xdac17f958d2ee523a2206206994597c13d831ec7"
// "0xDAC17F958D2EE523A2206206994597C13D831EC7"
```

Solana addresses use base58 encoding which is case-sensitive, so Solana addresses are stored and compared as-is.

## Address Extraction

The rule extracts target addresses from intents based on intent type:

| Intent Type | Address Field |
|-------------|---------------|
| `transfer` | `params.to` |
| `custom` | `params.programId` |
| `mint` | `params.collection` |
| `stake` | `params.validator` |
| `swap` | No target address (passes through) |

If no target address can be extracted (e.g., swap intents), the address check is skipped.

## Code Examples

### Transfer Allowlist

Only allow the agent to send funds to known, vetted addresses:

```typescript
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Treasury
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH", // Vendor
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Payment processor
  ],
});
```

Result: Transfers to any address NOT in this list will be denied.

### Program Allowlist

Restrict which Solana programs the agent can interact with:

```typescript
const rule = new AllowlistRule({
  allowPrograms: [
    "11111111111111111111111111111111",                 // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",    // Token Program
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter
  ],
});
```

Result: Custom intents targeting any program NOT in this list will be denied.

### Deny List

Block specific known-bad addresses without restricting everything else:

```typescript
const rule = new AllowlistRule({
  denyAddresses: [
    "ScamAddress111111111111111111111111111111111",
    "DrainerBot22222222222222222222222222222222222",
  ],
  denyPrograms: [
    "MaliciousProgram3333333333333333333333333333",
  ],
});
```

Result: These addresses and programs are always blocked. All other addresses and programs are allowed.

### Combined Allow + Deny Lists

```typescript
const rule = new AllowlistRule({
  allowAddresses: [
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ],
  denyPrograms: [
    "MaliciousProgram3333333333333333333333333333",
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
const config = rule.getConfig();
console.log("Allowed addresses:", config.allowAddresses);
console.log("Denied addresses:", config.denyAddresses);
console.log("Allowed programs:", config.allowPrograms);
console.log("Denied programs:", config.denyPrograms);
```

`getConfig()` returns copies of the lists. Mutating the returned arrays does not affect the rule.
