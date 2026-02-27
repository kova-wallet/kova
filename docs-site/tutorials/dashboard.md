# Kova Dashboard

::: info What you'll learn
- How to set up and run the Kova Dashboard for testing the SDK on Solana devnet
- The five dashboard pages: Dashboard, Wallet, Policy Builder, Transactions, and Approvals
- How wallet persistence works with `keypair.json`
- Important limitations and when NOT to use the dashboard
:::

The Kova Dashboard is a **Next.js admin UI** for testing and exploring the SDK on Solana devnet. Think of it as a visual control panel for your agent wallet -- you can create wallets, configure policies, execute transactions, and approve requests, all from a browser instead of writing code.

### When would I use this?

- **Learning the SDK**: See how all the pieces fit together before writing integration code.
- **Testing policies**: Build and apply policy configurations visually, then execute transactions to see which ones pass or get denied.
- **Demos and presentations**: Show stakeholders how the SDK works without writing a line of code.
- **Debugging**: Inspect transaction history, policy summaries, and approval flows in real time.

::: danger Important
The dashboard is for **development and testing only**. It uses `MemoryStore` (state resets on restart) and `LocalSigner` (private key in process memory). Never use it with real funds on mainnet.
:::

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |

## Setup

```bash
# From the kova-wallet project root, navigate to the dashboard directory.
cd dashboard

# Install the dashboard's dependencies (Next.js, React, Tailwind CSS, etc.).
npm install

# (Optional) Pre-generate a devnet keypair so the wallet is ready on first launch.
npx tsx wallet/generate.ts

# Start the development server.
npm run dev
```

Open `http://localhost:3000` in your browser. The dashboard redirects to the Dashboard home page automatically.

::: tip Auto-generated devnet keypair
On first startup, if no keypair exists, you can create one from the Wallet page. Alternatively, run `npx tsx wallet/generate.ts` to pre-generate a devnet keypair. The keypair is saved to `dashboard/wallet/keypair.json` and auto-loaded on subsequent starts -- no manual wallet creation step needed.
:::

## Dashboard Pages

The sidebar navigation provides access to five pages:

| Page | Path | Purpose |
|------|------|---------|
| **Dashboard** | `/dashboard` | Overview: balance, policy summary, recent transaction history |
| **Wallet** | `/wallet` | Create/import wallet, request devnet airdrop, destroy wallet |
| **Policy** | `/policy` | Visual policy builder with 6 rule types and live JSON preview |
| **Transactions** | `/transactions` | Execute transfers and swaps via forms, view results |
| **Approvals** | `/approvals` | Real-time approval queue with approve/reject actions |

### Dashboard Home

The main dashboard page shows three panels:

- **Balance Card** -- Displays the current SOL balance for the active devnet wallet. Polls every 15 seconds.
- **Policy Summary Card** -- Shows the active policy rules (spending limits with actual amounts, rate limits, approval thresholds, circuit breaker status) in a human-readable format. Polls every 30 seconds.
- **Transaction History Table** -- Lists the most recent transactions with their status (confirmed, denied, failed, pending). Polls every 10 seconds.

If no wallet has been created yet, the page displays a prompt linking to the Wallet page.

### Wallet Page

The Wallet page handles wallet lifecycle:

- **Create Wallet** -- Two modes: **Generate New** creates a fresh Solana devnet keypair, or **Import Existing** accepts a secret key as a JSON array of 64 bytes (e.g., `[1, 2, 3, ..., 64]`).
- **Airdrop** -- Requests free devnet SOL from the Solana faucet. If the RPC faucet is rate-limited, visit [https://faucet.solana.com](https://faucet.solana.com) and paste your wallet address.
- **Copy Address** -- Copies the wallet's public key to the clipboard for use in other tools.
- **Destroy Wallet** -- Wipes the in-memory wallet state (with confirmation dialog). The `keypair.json` file is not deleted, so you can re-create the wallet from the same keypair.

::: tip
Devnet SOL has no monetary value -- it is free test currency provided by Solana for development. You can request as much as you need.
:::

### Policy Builder

The Policy Builder page provides a visual interface for configuring all six policy rule types:

| Rule Section | What It Configures |
|-------------|-------------------|
| **Spending Limits** | Per-transaction, daily, weekly, and monthly caps (e.g., "max 10 SOL per transaction, 50 SOL per day") |
| **Address Allowlist** | Allowed/denied recipient addresses and program IDs |
| **Rate Limits** | Max transactions per minute and per hour |
| **Active Hours** | Timezone, day-of-week, and start/end time windows |
| **Approval Gate** | Amount threshold above which human approval is required, with configurable timeout and cumulative window |
| **Cooldown** | Mandatory wait period after high-value transactions |

Each section has a **toggle switch** to enable/disable it. As you configure rules, the **live JSON preview panel** on the right shows the resulting `PolicyConfig` object -- the same JSON structure you would pass to `Policy.fromJSON()` in code.

The preview panel also shows **real-time validation**: a green checkmark when the policy is valid, or a red error message explaining what needs to be fixed.

When you click **"Apply Policy"**, the dashboard destroys the current wallet engine and re-creates it with the new policy rules. The same keypair and devnet SOL balance are preserved, but spending counters and rate limits reset to zero.

::: tip From dashboard to code
The JSON preview shows the exact `PolicyConfig` object. You can copy it and use it directly in your code:
```typescript
const policy = Policy.fromJSON(pastedConfig);
```
:::

### Transactions Page

The Transactions page provides two tab-based forms:

**Transfer Tab:**
- Recipient address (Solana public key)
- Amount (e.g., `0.01`)
- Token (defaults to `SOL`)
- Optional reason/metadata

**Swap Tab:**
- From token (defaults to `SOL`)
- To token (defaults to `USDC`)
- Amount to swap
- Max slippage percentage (defaults to `0.5%`)

Results appear below the form showing the transaction status, summary, transaction ID (with link to Solana Explorer if confirmed), or error details (if denied or failed).

Each transaction goes through the full SDK pipeline: validation, policy evaluation, signing, broadcast, and audit logging -- exactly as it would in production code.

### Approvals Page

The Approvals page provides a real-time approval queue using **Server-Sent Events (SSE)**. When a transaction triggers the Approval Gate rule (e.g., amount exceeds the configured threshold), a card appears with:

- Transaction summary and amount
- Target address
- The stated reason from the agent
- Daily budget context (amount spent / daily limit)
- A **countdown timer** showing remaining time before timeout
- **Approve** and **Reject** buttons

Clicking a button sends the decision back to the SDK, which then either proceeds with or denies the transaction. The buttons are disabled once the timer expires.

A connection status indicator (green/red dot) shows whether the SSE stream is active.

::: tip
The dashboard uses its own `DashboardApprovalChannel` implementation instead of `TelegramApprovalBot`. This channels approval requests through the browser instead of Telegram, making it easy to test the approval flow without configuring an external bot.
:::

## Wallet Persistence

The dashboard persists wallet keypairs to `dashboard/wallet/keypair.json`:

- **On create**: The keypair bytes are written to `keypair.json` as a JSON array.
- **On server start**: If `keypair.json` exists, the dashboard auto-loads it and initializes the wallet with a default policy (10 SOL per-tx, 50 SOL daily, 5 txns/min rate limit).
- **On destroy**: The in-memory state is cleared, but `keypair.json` remains on disk.

This means the same devnet wallet address and SOL balance persist across dashboard restarts, even though the `MemoryStore` state (spending counters, audit logs, transaction history) resets.

::: warning
`keypair.json` is gitignored. If you need to share the keypair across machines, copy the file manually. Never commit private keys to version control.
:::

## Architecture

The dashboard is structured as a standard Next.js App Router application:

```
dashboard/
  src/
    app/                    # Next.js pages and API routes
      api/                  # REST API endpoints
        wallet/             # create, balance, airdrop, destroy
        policy/             # get, post, preview
        transactions/       # execute, history
        approvals/          # stream (SSE), respond
      dashboard/            # Dashboard home page
      wallet/               # Wallet management page
      policy/               # Policy builder page
      transactions/         # Transaction forms page
      approvals/            # Approval queue page
    components/             # React components organized by page
    hooks/                  # Custom hooks (usePolling, useApprovalStream)
    lib/                    # Server-side logic
      wallet-manager.ts     # Wallet singleton (creates AgentWallet, manages state)
      approval-channel.ts   # DashboardApprovalChannel (SSE-based)
      policy-helpers.ts     # PolicyConfig → rule instances
      constants.ts          # RPC URL, airdrop amount, timeouts
  wallet/
    generate.ts             # One-time keypair generation script
    keypair.json            # Devnet keypair (gitignored)
```

The server-side wallet state is managed by a **singleton** in `wallet-manager.ts`. All API routes share this singleton, which holds the `AgentWallet` instance, `MemoryStore`, and `DashboardApprovalChannel`.

## Example Workflow

Here is a typical testing workflow using the dashboard:

1. **Start the dashboard** with `npm run dev` and open `http://localhost:3000` in your browser.
2. **Fund the wallet** by clicking "Airdrop" on the Wallet page (or use [faucet.solana.com](https://faucet.solana.com)).
3. **Configure a policy** on the Policy page -- for example, enable Spending Limits (0.01 SOL per-tx) and Approval Gate (above 0.005 SOL).
4. **Execute a transfer** on the Transactions page -- try sending 0.005 SOL to any devnet address.
5. **Watch the approval flow** -- if the amount exceeds the approval threshold, switch to the Approvals page to approve or reject.
6. **Check the dashboard** -- the Balance Card updates, the Transaction History shows the result, and the Policy Summary reflects remaining budget.

## Important Limitations

::: warning
- **Devnet only** -- The dashboard is hardcoded to use Solana devnet. It cannot connect to mainnet.
- **MemoryStore** -- All SDK state (spending counters, rate limits, audit logs) resets when the Next.js server restarts. Only the keypair is persisted to disk.
- **LocalSigner** -- The private key is held in process memory with `dangerouslyAllowInProduction: true`. This is acceptable for devnet testing only.
- **Not for production** -- The dashboard is a development tool. Do not expose it to untrusted networks or use it with real funds.
- **Single instance** -- Only one browser tab should interact with the dashboard at a time to avoid race conditions in the in-memory state.
:::

## See Also

- [Your First Agent Wallet](/tutorials/first-wallet) -- Build the same setup programmatically
- [Policy Cookbook](/tutorials/policy-cookbook) -- Advanced policy configurations you can try in the Policy Builder
- [AgentWallet](/guide/wallet) -- Full API reference for the wallet the dashboard wraps
- [Stores](/guide/stores) -- Understanding MemoryStore vs SqliteStore persistence
