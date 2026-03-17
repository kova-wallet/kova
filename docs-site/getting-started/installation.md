# Installation

::: info What you'll learn
- How to install the kova SDK and verify it works
- How to configure TypeScript for kova
- How to set up persistent storage for production use
- How to run a local development environment with a test blockchain
:::

## Prerequisites

Before installing `kova`, ensure you have the following:

| Requirement | Version | Why |
|-------------|---------|-----|
| Node.js     | 18.0 or later | kova uses ES2022 features (top-level await, Object.hasOwn) that require Node 18+ |
| npm          | 9.0 or later (ships with Node 18+) | Required for package installation and dependency resolution |

::: tip
You can check your current versions by running `node -v` and `npm -v` in your terminal. If you don't have Node.js installed, download it from [nodejs.org](https://nodejs.org).
:::

## Install

Install `kova` from npm:

```bash
# Install the kova SDK from the npm registry.
# This single package provides everything you need: AgentWallet, PolicyEngine,
# signers, chain adapters, AI framework adapters, and all built-in policy rules.
# No additional peer dependencies are required for basic usage.
npm install kova
```

This is the only required package. It includes everything you need to create wallets, define policies, and interact with the Solana blockchain.

## Verify Installation

Create a simple test file to verify the SDK is installed correctly:

```typescript
// verify.ts -- A quick smoke test to confirm kova is installed and all
// core exports are accessible. Run this after `npm install kova` to
// verify that your environment is set up correctly.

import {
  AgentWallet,          // The main wallet class that orchestrates signers, policies, and chain adapters
  Policy,               // Fluent builder for creating policy configurations declaratively
  PolicyEngine,         // Evaluates an ordered list of PolicyRule instances against each transaction intent
  MemoryStore,          // In-memory implementation of the Store interface (for dev/testing only)
  LocalSigner,          // Signs transactions using a Solana Keypair held in local memory
  SolanaAdapter,        // Chain adapter that connects to a Solana RPC node for building and broadcasting transactions
  SpendingLimitRule,    // Policy rule that enforces per-transaction, daily, weekly, and monthly spending caps
} from "@kova-sdk/wallet";

// Each console.log checks that the imported symbol is a constructor function ("function"),
// confirming the SDK is properly installed and all exports are accessible.
console.log("kova installed successfully!");
console.log("AgentWallet:", typeof AgentWallet);       // Expected: "function"
console.log("Policy:", typeof Policy);                 // Expected: "function"
console.log("PolicyEngine:", typeof PolicyEngine);     // Expected: "function"
console.log("MemoryStore:", typeof MemoryStore);       // Expected: "function"
console.log("LocalSigner:", typeof LocalSigner);       // Expected: "function"
console.log("SolanaAdapter:", typeof SolanaAdapter);   // Expected: "function"
console.log("SpendingLimitRule:", typeof SpendingLimitRule);  // Expected: "function"
```

Run it with:

```bash
# Run the verification script using tsx (a TypeScript executor).
# npx runs the locally-installed tsx binary without requiring a global install.
# If this prints "kova installed successfully!" and all types are "function", the SDK is ready.
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

::: tip What is tsx?
`tsx` is a tool that runs TypeScript files directly without a separate compile step. `npx` downloads and runs it on-the-fly, so you don't need to install it globally. If you prefer, you can also compile with `tsc` and run with `node` instead.
:::

If you see all `function` outputs, kova is installed correctly and every component is accessible. If any import fails, double-check that you ran `npm install kova` in the correct project directory.

## Peer Dependencies

The `@solana/web3.js` library is bundled with `kova` -- you do not need to install it separately. The SDK re-exports everything you need for Solana interaction.

### Persistent Storage (Recommended for Production)

By default, kova uses an in-memory store that loses all state when the process exits. This means spending limits, rate limits, and the circuit breaker reset on every restart -- which is fine for development but defeats the purpose of having guardrails in production.

::: warning Why this matters
Imagine setting a daily spending limit of 5 SOL. Without persistent storage, restarting your server resets the counter to zero -- the agent could spend another 5 SOL immediately. In production, you need `SqliteStore` or `RedisStore` so limits survive restarts.
:::

For persistent storage on a **single server**, install `better-sqlite3`:

```bash
# Install better-sqlite3, a native Node.js addon that provides synchronous
# SQLite bindings. This is required for SqliteStore, which persists spending
# counters, rate limits, circuit breaker state, audit logs, and idempotency
# caches to a local file so they survive process restarts.
npm install better-sqlite3
```

This lets you use `SqliteStore`, which persists the SDK's internal safety state to a local file. See the [Stores guide](/guide/stores) for details.

::: warning
`better-sqlite3` is a native Node.js addon. It requires a C++ compiler (e.g., `gcc`, `clang`, or MSVC) to build during installation. On macOS, ensure Xcode Command Line Tools are installed (`xcode-select --install`). On Linux, install `build-essential` (`sudo apt-get install build-essential`). On Windows, install the Visual Studio C++ build tools.
:::

### Multi-Server Deployments (Redis)

For production deployments with **multiple servers or processes**, install `ioredis`:

```bash
# Install ioredis, a Redis client for Node.js. This is required for RedisStore,
# which shares spending counters, rate limits, and audit logs across multiple
# processes and servers via a Redis backend.
npm install ioredis
```

This lets you use `RedisStore`, which provides shared state across all instances connected to the same Redis server. See the [Stores guide](/guide/stores#redisstore) for details.

## TypeScript Configuration

`kova` ships with full TypeScript declarations. For the best experience, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    // Target ES2022 to enable modern JS features like top-level await,
    // Array.prototype.at(), and Object.hasOwn() that kova relies on internally.
    "target": "ES2022",

    // Use Node16 module system, which supports both ESM and CJS with
    // proper package.json "exports" resolution -- required for kova's exports map.
    "module": "Node16",

    // Node16 module resolution follows the same rules as Node.js itself,
    // including reading the "exports" field in package.json for subpath imports.
    "moduleResolution": "Node16",

    // Enable all strict type-checking options. kova ships with full
    // TypeScript declarations, so strict mode catches misuse at compile time.
    "strict": true,

    // Allow default imports from CommonJS modules (e.g., `import Anthropic from ...`).
    // Some kova peer dependencies use CJS, so this avoids interop issues.
    "esModuleInterop": true
  }
}
```

::: info Already have a tsconfig.json?
You don't need to replace your existing configuration. Just ensure the settings above are present. The most important ones are `module: "Node16"` and `moduleResolution: "Node16"` -- without them, TypeScript won't correctly resolve kova's package exports.
:::

## Local Development Setup

kova includes a one-command setup script that installs Solana CLI tools (command-line programs for interacting with Solana), starts a local test validator (a personal, private Solana blockchain running on your machine for testing), generates and funds a keypair (a pair of cryptographic keys -- one public, one private -- that act as your wallet's identity), and optionally collects API keys for Anthropic and Telegram integrations.

```bash
# Interactive setup: installs Solana CLI tools, starts a local test validator,
# generates and funds a keypair, and prompts you for optional API keys
# (Anthropic for Claude integration, Telegram for approval bots).
npm run local:dev

# Quick mode: same as above but skips all interactive prompts.
# Uses default settings and does not configure optional integrations.
# Best for CI environments or when you just want a validator running fast.
npm run local:dev -- --quick

# Check whether the local Solana test validator is currently running
# and display its RPC endpoint and health status.
npm run local:status

# Gracefully stop the local Solana test validator process.
# This frees up port 8899 (default RPC) and 8900 (default WebSocket).
npm run local:stop
```

### What this means for you

The local test validator gives you a completely free, private blockchain for development. You can send as many transactions as you want without spending real money or waiting for network confirmations. It's like having a local database server -- fast iteration with zero cost.

After setup, a `.env.local` file is created with all configuration. Load it before running examples:

```bash
# Load the environment variables generated by `npm run local:dev`.
# This file contains SOLANA_RPC_URL, SOLANA_SECRET_KEY, and any API keys
# you configured during setup. It must be sourced before running examples.
source .env.local

# Run the basic transfer example: creates a wallet, funds it via airdrop,
# and executes a simple SOL transfer on the local test validator.
npx tsx examples/basic-transfer/index.ts

# Run the Claude agent example: wires a kova wallet to the Anthropic Messages
# API so Claude can check balances and send payments via tool calls.
# Requires ANTHROPIC_API_KEY in .env.local.
npx tsx examples/claude-agent/index.ts

# Run the policy playground: experiments with different policy configurations
# entirely in-memory (no validator required). Great for testing policy rules
# like spending limits, allowlists, and rate limits without any network calls.
npx tsx examples/policy-playground/index.ts
```

::: tip
The policy playground example runs entirely in-memory and does not require a Solana validator. It is the fastest way to experiment with policy configurations.
:::

## Common Questions

**Q: Do I need a Solana wallet or any blockchain tools installed before using kova?**
No. The `npm run local:dev` command installs everything for you, including the Solana CLI tools. For production, you only need Node.js and the kova npm package.

**Q: Can I use kova with JavaScript instead of TypeScript?**
Yes. kova works with plain JavaScript. The TypeScript declarations are included for developers who use TypeScript, but they're not required. You can write your code in `.js` files and skip the `tsconfig.json` configuration.

**Q: What is devnet, and will it cost me real money?**
Devnet (short for "development network") is a free test version of the Solana blockchain. The SOL tokens on devnet have no real-world value. You can request free test SOL from the faucet at any time. All kova examples default to devnet so you can experiment safely.

**Q: What is an RPC endpoint?**
RPC stands for "Remote Procedure Call." An RPC endpoint is simply a URL that your code uses to communicate with the Solana blockchain -- similar to a REST API base URL. The devnet RPC endpoint (`https://api.devnet.solana.com`) is free and public. For production, you'd use a dedicated provider like Helius or QuickNode for better performance and reliability.

**Q: I got an error during `better-sqlite3` installation. What do I do?**
This usually means a C++ compiler is missing. On macOS, run `xcode-select --install`. On Ubuntu/Debian, run `sudo apt-get install build-essential`. On Windows, install the "Desktop development with C++" workload from Visual Studio Installer. If you're just getting started, you can skip `better-sqlite3` entirely and use `MemoryStore` for development.

## Next Steps

Once installed, head to the [Quick Start](/getting-started/quick-start) guide to build your first policy-constrained wallet and execute a transaction.
