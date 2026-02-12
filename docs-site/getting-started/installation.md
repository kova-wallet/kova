# Installation

## Prerequisites

Before installing `kova`, ensure you have the following:

| Requirement | Version |
|-------------|---------|
| Node.js     | 18.0 or later |
| npm          | 9.0 or later (ships with Node 18+) |

::: tip
You can check your current versions by running `node -v` and `npm -v` in your terminal.
:::

## Install

Install `kova` from npm:

```bash
npm install kova
```

## Verify Installation

Create a simple test file to verify the SDK is installed correctly:

```typescript
// verify.ts
import {
  AgentWallet,
  Policy,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
} from "kova";

console.log("kova installed successfully!");
console.log("AgentWallet:", typeof AgentWallet);
console.log("Policy:", typeof Policy);
console.log("PolicyEngine:", typeof PolicyEngine);
console.log("MemoryStore:", typeof MemoryStore);
console.log("LocalSigner:", typeof LocalSigner);
console.log("SolanaAdapter:", typeof SolanaAdapter);
console.log("SpendingLimitRule:", typeof SpendingLimitRule);
```

Run it with:

```bash
npx tsx verify.ts
```

Expected output:

```
kova installed successfully!
AgentWallet: function
Policy: function
PolicyEngine: function
MemoryStore: function
LocalSigner: function
SolanaAdapter: function
SpendingLimitRule: function
```

## Peer Dependencies

The `@solana/web3.js` library is bundled with `kova` -- you do not need to install it separately. The SDK re-exports everything you need for Solana interaction.

### Persistent Storage (Recommended for Production)

By default, Kova uses an in-memory store that loses all state when the process exits. This means spending limits, rate limits, and the circuit breaker reset on every restart -- which is fine for development but defeats the purpose of having guardrails in production.

For persistent storage, install `better-sqlite3`:

```bash
npm install better-sqlite3
```

This lets you use `SqliteStore`, which persists the SDK's internal safety state (spending counters, rate limits, circuit breaker, audit log, and idempotency cache) to a local file. See the [Stores guide](/guide/stores) for details.

::: warning
`better-sqlite3` is a native Node.js addon. It requires a C++ compiler (e.g., `gcc`, `clang`, or MSVC) to build during installation. On macOS, ensure Xcode Command Line Tools are installed. On Linux, install `build-essential`.
:::

## TypeScript Configuration

`kova` ships with full TypeScript declarations. For the best experience, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Local Development Setup

kova includes a one-command setup script that installs Solana CLI tools, starts a local test validator, generates and funds a keypair, and optionally collects API keys for Anthropic and Telegram integrations.

```bash
# Interactive setup (prompts for optional API keys)
npm run local:dev

# Quick mode — no prompts, just start everything
npm run local:dev -- --quick

# Check validator status
npm run local:status

# Stop the validator
npm run local:stop
```

After setup, a `.env.local` file is created with all configuration. Load it before running examples:

```bash
source .env.local
npx tsx examples/basic-transfer/index.ts
npx tsx examples/claude-agent/index.ts
npx tsx examples/policy-playground/index.ts
```

::: tip
The policy playground example runs entirely in-memory and does not require a Solana validator. It is the fastest way to experiment with policy configurations.
:::

## Next Steps

Once installed, head to the [Quick Start](/getting-started/quick-start) guide to build your first policy-constrained wallet and execute a transaction.
