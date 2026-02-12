# Production Deployment

> **What you'll learn:** How to harden your agent wallet for production use with real money. This guide covers switching from in-memory storage to persistent SQLite, configuring circuit breakers to halt runaway agents, setting up audit log monitoring and alerting, managing secrets securely, and deploying with Docker or PM2.

This guide covers hardening your agent wallet for production use. You will learn how to switch from in-memory storage to persistent SQLite, configure <Term id="circuit-breaker">circuit breakers</Term>, set up monitoring and alerting, and follow security best practices.

::: tip New to production deployments?
"Production" means your code is running with real money and real users. The stakes are higher than development: if something goes wrong, funds can be lost. This guide walks you through every hardening step so you can deploy with confidence. Even if you have deployed web applications before, crypto wallets have unique concerns (key management, tamper-evident logging, circuit breakers) that this guide addresses.
:::

## Prerequisites

- **A working agent wallet** (see [Your First Agent Wallet](/tutorials/first-wallet))
- **Familiarity with the policy system** (see [Policy Cookbook](/tutorials/policy-cookbook))
- **A Solana RPC endpoint** -- a private provider like [Helius](https://helius.dev/), [QuickNode](https://quicknode.com/), or [Alchemy](https://alchemy.com/) is strongly recommended for production
- **Basic familiarity with Docker or PM2** for process management (we will walk through both)

## 1. Switch from MemoryStore to SqliteStore

`MemoryStore` loses all data when your process restarts. For production, use `SqliteStore` which persists spending counters, rate limit windows, and audit logs to a SQLite database file.

```typescript
import { SqliteStore } from "kova";

// SqliteStore is the production-ready Store implementation.
// It persists all SDK state to a local SQLite database file using WAL
// (Write-Ahead Logging) mode for high write performance and crash safety.
// Unlike MemoryStore, data survives process restarts, so spending counters,
// rate limit windows, and audit logs are maintained across deployments.
const store = new SqliteStore({
  path: "./data/kova.db",  // File path for the SQLite database.
                            // The directory must exist; the file is created if it does not.
                            // In production, use an absolute path outside the app directory
                            // (e.g., /var/data/kova.db) to prevent accidental deletion.
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path for the SQLite database |

::: tip
Place the database file outside your application directory (e.g., `/var/data/kova.db`) to prevent accidental deletion during deployments.
:::

**Why this matters:**
- Spending limit counters (tracked in <Term id="lamports" />) survive restarts (prevents a fresh daily budget on every deploy)
- Rate limit windows are preserved across process restarts
- Audit log entries are permanently stored for compliance and debugging
- Transaction history is available for long-term analysis

::: details What just happened?
When you switch from `MemoryStore` to `SqliteStore`, the SDK creates a SQLite database file at the specified path. This file contains tables for spending counters, rate limit windows, audit log entries, and idempotency caches. SQLite uses WAL (Write-Ahead Logging) mode by default, which means writes are fast and the database is crash-safe -- even if your process crashes mid-write, the database will not be corrupted.

The single most important benefit: **your daily spending limit counter survives restarts.** With `MemoryStore`, every time your process restarts, the agent gets a fresh daily budget. With `SqliteStore`, the counter persists, so the daily limit is enforced correctly across deployments, crashes, and restarts.
:::

## 2. Configure a Circuit Breaker

The circuit breaker stops all transactions if too many consecutive failures occur. This protects against cascading failures, RPC outages, or unexpected errors.

```typescript
import { AgentWallet, LocalSigner, SolanaAdapter, PolicyEngine, AuditLogger } from "kova";

// Configure the AgentWallet with a circuit breaker to protect against
// cascading failures, RPC outages, or a runaway agent hammering the wallet
// with requests that will all be denied.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
  circuitBreaker: {
    threshold: 5,       // After 5 consecutive policy denials, the circuit "opens."
                        // While open, ALL transactions are immediately rejected with
                        // CIRCUIT_BREAKER_OPEN, without even evaluating policy rules.
    cooldownMs: 60_000, // The circuit stays open for 1 minute (60,000 ms), then
                        // automatically resets to "closed" (normal operation).
                        // During cooldown, the agent should investigate why denials occurred.
  },
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `threshold` | `number` | Consecutive denials before the circuit opens. Default: 5 |
| `cooldownMs` | `number` | Milliseconds the circuit stays open before auto-resetting. Default: 300,000 (5 min) |

**Circuit breaker states:**

1. **Closed** (normal) -- Transactions flow normally. The breaker tracks consecutive policy denials.
2. **Open** (blocking) -- All transactions are immediately rejected with `CIRCUIT_BREAKER_OPEN`. After the cooldown (<Term id="ttl" />) expires, the circuit automatically resets to Closed.

::: warning
When the circuit breaker is open, ALL transactions are rejected, including small ones that would normally succeed. This <Term id="fail-closed" /> behavior is by design -- it prevents the agent from continuing to operate during a systemic failure.
:::

## 3. Set Up Audit Failure Alerting

Configure a callback that fires when the audit logger detects integrity violations or consecutive write failures.

```typescript
import { AuditLogger } from "kova";

// Configure the AuditLogger with failure alerting.
// The audit logger is critical infrastructure: if it cannot write entries,
// the entire wallet stops processing transactions (fail-closed behavior).
// The onAuditFailure callback fires when consecutive write failures occur,
// giving you a chance to alert your team before the wallet locks up.
const logger = new AuditLogger({
  store,                       // The persistent store where audit entries are written
  maxConsecutiveFailures: 3,   // After 3 consecutive write failures, the audit logger
                               // enters a failed state and blocks ALL transactions.
                               // This prevents unaudited transactions from occurring.
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    // This callback fires on each audit write failure.
    // Use it to alert your team via your preferred monitoring system.
    console.error("[CRITICAL] Audit failure:", error.message);

    // Example: send a Slack alert to the #wallet-alerts channel.
    // Replace with your actual Slack webhook integration.
    sendSlackAlert({
      channel: "#wallet-alerts",
      text: `Audit failure in kova: ${error.message}`,
      severity: "critical",
    });

    // Example: trigger a PagerDuty incident for immediate response.
    // Replace with your actual PagerDuty integration.
    triggerPagerDuty({
      summary: `kova audit integrity failure`,
      details: error.message,
    });
  },
});
```

You can also pass the `onAuditFailure` callback directly to the `AgentWallet` constructor:

```typescript
// Alternative: pass the onAuditFailure callback directly to AgentWallet
// instead of to the AuditLogger. Both approaches work; this one is more
// convenient if you do not need to configure maxConsecutiveFailures separately.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    // Called when the audit logger fails to write an entry.
    // consecutiveFailures tells you how many failures in a row have occurred.
    console.error("[CRITICAL] Audit failure:", error.message);
    // Trigger alerts via Slack, PagerDuty, email, etc.
  },
});
```

## 4. Environment Variable Management

Never hardcode sensitive values. Use a structured configuration pattern:

```typescript
// Define a typed configuration interface for all wallet settings.
// This centralizes env var loading and makes it easy to see at a glance
// what the application needs to run.
interface WalletConfig {
  solanaSecretKey: string;       // Required: JSON-encoded byte array for the Solana keypair
  solanaRpcUrl: string;          // Required: Solana RPC endpoint URL
  dbPath: string;                // Required: file path for the SQLite database
  telegramBotToken?: string;     // Optional: Telegram bot token for approval flows
  telegramChatId?: string;       // Optional: Telegram chat ID for approval messages
}

// loadConfig() validates and loads all environment variables at startup.
// This "fail fast" pattern catches missing configuration immediately
// rather than failing later during a transaction attempt.
function loadConfig(): WalletConfig {
  // Helper: load a required env var or throw with a clear error message.
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  // Helper: load an optional env var (returns undefined if not set).
  const optional = (name: string): string | undefined => {
    return process.env[name];
  };

  return {
    solanaSecretKey: required("SOLANA_SECRET_KEY"),   // Wallet keypair (never log this!)
    solanaRpcUrl: required("SOLANA_RPC_URL"),         // Private RPC recommended (Helius, QuickNode)
    dbPath: required("WALLET_DB_PATH"),               // SQLite database file path
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"), // Only needed if using Telegram approval
    telegramChatId: optional("TELEGRAM_CHAT_ID"),     // Only needed if using Telegram approval
  };
}

// Load config at startup. If any required var is missing, the process exits immediately.
const config = loadConfig();
```

::: danger
Never log secret keys. Never commit `.env` files. Use a secrets manager (AWS Secrets Manager, HashiCorp Vault, Doppler, etc.) in production.
:::

## 5. Monitoring Audit Integrity

Set up periodic integrity verification to detect any tampering with the audit log's <Term id="hash-chain" />.

```typescript
import { AuditLogger } from "kova";

// monitorIntegrity() verifies the SHA-256 hash chain of the audit log.
// Each entry includes the hash of the previous entry, forming a tamper-evident chain.
// If any entry has been modified, deleted, or inserted, the chain will be broken.
async function monitorIntegrity(logger: AuditLogger) {
  // Verify the last 1000 entries. In production, adjust this number based
  // on your transaction volume and how far back you want to verify.
  const report = await logger.verifyIntegrity(1000);

  console.log(`[Integrity Check] Valid: ${report.valid}`);
  console.log(`[Integrity Check] Entries checked: ${report.entriesChecked}`);

  if (!report.valid) {
    // The hash chain is broken -- this indicates tampering or data corruption.
    // firstBrokenAt is the index of the first entry where the hash does not match.
    console.error(
      `[ALERT] Audit chain broken at entry: ${report.firstBrokenAt}`
    );
    // In production: trigger a critical alert (Slack, PagerDuty, etc.)
    // and consider pausing the agent until a human investigates.
  }

  return report;
}

// Schedule integrity checks to run every 5 minutes (300,000 ms).
// This catches tampering quickly while keeping the performance overhead low.
// Wrap in try/catch so a single check failure does not crash the process.
setInterval(async () => {
  try {
    await monitorIntegrity(logger);
  } catch (error) {
    console.error("[Integrity Monitor] Check failed:", error);
  }
}, 5 * 60 * 1000);  // 5 minutes in milliseconds
```

The `IntegrityReport` has the following shape:

| Field | Type | Description |
|-------|------|-------------|
| `valid` | `boolean` | Whether the entire audit chain is intact |
| `entriesChecked` | `number` | Number of entries verified |
| `firstBrokenAt` | `number \| undefined` | Index of the first corrupted entry (if any) |

## 6. Database Backup Strategy

SQLite databases should be backed up regularly. Here is a simple approach:

```typescript
import { copyFileSync, mkdirSync, existsSync } from "fs";

// backupDatabase() creates a timestamped copy of the SQLite database file.
// This is a simple file-copy approach suitable for low-write environments.
// For databases under heavy write load, use SQLite's backup API instead.
function backupDatabase(dbPath: string, backupDir: string) {
  // Create the backup directory if it does not exist.
  // { recursive: true } creates parent directories as needed.
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Generate a unique filename using the current ISO timestamp.
  // Replace colons and dots with hyphens for filesystem compatibility.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${backupDir}/kova-${timestamp}.db`;

  // Copy the database file to the backup location.
  // WARNING: This is only safe if the database is not being written to at
  // this exact moment. For write-heavy production use, prefer the SQLite
  // Online Backup API or the `sqlite3 .backup` CLI command.
  copyFileSync(dbPath, backupPath);
  console.log(`Database backed up to: ${backupPath}`);

  return backupPath;
}

// Schedule daily database backups (every 24 hours).
// Wrap in try/catch so a backup failure does not crash the process.
setInterval(() => {
  try {
    backupDatabase("./data/kova.db", "./backups");
  } catch (error) {
    console.error("Backup failed:", error);
  }
}, 24 * 60 * 60 * 1000);  // 24 hours in milliseconds
```

::: warning
For production SQLite backups under write load, use the SQLite Online Backup API or `sqlite3 .backup` command to avoid backing up a database mid-write. The simple `copyFileSync` approach shown above is safe only if the database is not being written to at that moment.
:::

## 7. Log Rotation and Cleanup

Over time, the audit log and transaction history will grow. Implement a cleanup strategy:

```typescript
// cleanupOldEntries() identifies audit log entries older than the specified
// number of days, archives them, and optionally deletes them from the store.
// This prevents unbounded database growth in long-running production deployments.
async function cleanupOldEntries(store: SqliteStore, maxAgeDays: number) {
  // Calculate the cutoff date: any entry older than this will be archived.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  // Retrieve up to 10,000 recent entries from the audit log.
  // Note: getRecent returns entries in reverse chronological order.
  const oldEntries = await store.getRecent("audit_log", 10000);

  // Filter for entries that are older than the cutoff date.
  const toArchive = oldEntries.filter(
    (entry) => new Date(entry.timestamp) < cutoffDate
  );

  if (toArchive.length > 0) {
    console.log(`Archiving ${toArchive.length} entries older than ${maxAgeDays} days`);
    // TODO: Write the entries to an archive file, S3 bucket, or cold storage
    // before deleting them from the active database. This preserves the full
    // audit trail for compliance while keeping the active database small.
  }
}

// Schedule weekly cleanup, retaining the most recent 90 days of history.
// Older entries should be archived to cold storage before removal.
setInterval(() => {
  cleanupOldEntries(store, 90).catch(console.error);
}, 7 * 24 * 60 * 60 * 1000);  // 7 days in milliseconds
```

## 8. Security Checklist

Before deploying to production, verify every item on this checklist:

| Check | Details |
|-------|---------|
| No hardcoded keys | All secrets loaded from environment or secrets manager |
| Allowlist configured | Only approved recipient addresses can receive funds |
| Spending limits set | Both per-transaction and daily limits are defined |
| Rate limits enabled | Prevents rapid-fire transaction abuse |
| Approval gate for high value | Transactions above threshold require human approval |
| Circuit breaker enabled | Automatically halts on consecutive failures |
| SqliteStore in use | Persistent storage, not MemoryStore |
| Audit logger active | Every transaction attempt is logged |
| Integrity checks scheduled | Periodic `verifyIntegrity()` calls |
| RPC endpoint secured | Use a private RPC endpoint (Helius, QuickNode, etc.) |
| Error alerting configured | `onAuditFailure` callback sends notifications |
| Database backups scheduled | Regular backups of the SQLite database |
| Node.js process managed | Use PM2, systemd, or container orchestration |
| Keypair stored securely | Use KMS, HSM, or encrypted secrets manager |

::: danger
Do not skip the allowlist. Without it, a compromised agent can drain funds to any address. The allowlist is your most important line of defense.
:::

## 9. Example Production Configuration

Here is a complete production setup bringing together all the hardening techniques:

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  SqliteStore,           // Persistent storage (production-ready, unlike MemoryStore)
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  ApprovalGateRule,
  PolicyEngine,
  AuditLogger,
  TelegramApprovalBot,
} from "kova";

// --- Configuration ---
// Helper to load required environment variables. Throws immediately if missing.
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

// --- Store (persistent) ---
// SqliteStore persists spending counters, rate limits, audit logs, and
// idempotency caches to a SQLite file. State survives process restarts.
const store = new SqliteStore({
  path: required("WALLET_DB_PATH"),  // e.g., /var/data/kova.db
});

// --- Signer ---
// Reconstruct the Solana Keypair from the secret key environment variable.
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(required("SOLANA_SECRET_KEY")))
);
const signer = new LocalSigner(keypair);  // Signs transactions locally

// --- Chain ---
// Use a private RPC endpoint in production (Helius, QuickNode, etc.)
// to avoid public endpoint rate limits and improve reliability.
const chain = new SolanaAdapter({
  rpcUrl: required("SOLANA_RPC_URL"),   // Private RPC endpoint URL
  commitment: "confirmed",              // Wait for supermajority confirmation
});

// --- Approval ---
// Telegram bot for human-in-the-loop approval of high-value transactions.
const approvalBot = new TelegramApprovalBot({
  token: required("TELEGRAM_BOT_TOKEN"),             // Bot token from @BotFather
  chatId: required("TELEGRAM_CHAT_ID"),               // Chat ID for approval messages
  defaultTimeout: 300000,                              // 5 minutes to respond
  allowedUserIds: [required("TELEGRAM_CHAT_ID")],     // Only this user can approve/reject
  pollInterval: 2000,                                  // Check for responses every 2 seconds
});

// --- Policy ---
// Production policy with ALL five rule types for maximum protection:
//   1. Spending limits (per-tx + daily)
//   2. Address allowlist (only approved recipients)
//   3. Rate limits (prevent rapid-fire transactions)
//   4. Time windows (business hours only)
//   5. Approval gate (human approval for high-value transactions)
const policy = Policy.create("production-policy")
  .spendingLimit({
    perTransaction: { amount: "5.0", token: "SOL" },   // Max 5 SOL per transaction
    daily: { amount: "50.0", token: "SOL" },            // Max 50 SOL per day
  })
  .allowAddresses([
    // Load allowed addresses from environment variables.
    // In production, these might come from a config service or database.
    required("ALLOWED_ADDRESS_1"),
    required("ALLOWED_ADDRESS_2"),
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,  // Max 10 transactions per rolling minute
  })
  .activeHours({
    timezone: "America/New_York",  // All times in Eastern Time
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],  // Weekdays only
        start: "09:00",  // 9:00 AM ET
        end: "17:00",    // 5:00 PM ET
      },
    ],
  })
  .requireApproval({
    above: { amount: "2.0", token: "SOL" },  // Approve via Telegram for >= 2 SOL
    channel: "telegram",
    timeout: 300_000,                          // 5 minutes before auto-deny
  })
  .build();

// Create rule instances from the policy config in evaluation order.
// Cheapest rules first for early short-circuit on denial.
const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),     // Check spending caps
  new AllowlistRule({                                // Check recipient is approved
    allowAddresses: config.allowAddresses,
  }),
  new RateLimitRule(config.rateLimit!),              // Check transaction frequency
  new TimeWindowRule(config.activeHours!),           // Check business hours
  new ApprovalGateRule(config.approvalGate!),        // Human approval for high-value txs
];
// Pass the approval bot so the ApprovalGateRule can send Telegram messages.
const engine = new PolicyEngine(rules, store, approvalBot);

// --- Audit Logger ---
// Tamper-evident hash chain logger with failure alerting.
// If 3 consecutive writes fail, the logger blocks ALL transactions.
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,   // Lock down after 3 consecutive write failures
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    console.error("[CRITICAL] Audit failure:", error.message);
    // Send alert to your on-call team via Slack, PagerDuty, etc.
  },
});

// --- Wallet ---
// Assemble the production wallet with ALL hardening features:
//   - Persistent storage (SqliteStore)
//   - Circuit breaker (auto-halt on consecutive denials)
//   - Telegram approval (human-in-the-loop)
//   - Audit failure alerting
const wallet = new AgentWallet({
  signer,                    // Signs transactions with the local keypair
  chain,                     // Connects to Solana via private RPC
  policy: engine,            // Evaluates all 5 policy rules sequentially
  store,                     // Persistent SQLite store
  approval: approvalBot,     // Telegram approval for high-value transactions
  logger,                    // SHA-256 hash chain audit log
  circuitBreaker: {
    threshold: 5,            // Open circuit after 5 consecutive denials
    cooldownMs: 60_000,      // 1 minute cooldown before auto-reset
  },
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    // Wallet-level audit failure handler (runs in addition to logger's handler).
    console.error("[CRITICAL] Wallet audit failure:", error.message);
  },
});

// --- Monitoring ---
// Schedule periodic audit integrity checks every 5 minutes.
// If the hash chain is broken, log an alert for investigation.
setInterval(async () => {
  try {
    const report = await logger.verifyIntegrity(1000);
    if (!report.valid) {
      console.error(`[ALERT] Audit broken at entry ${report.firstBrokenAt}`);
      // In production: trigger PagerDuty, Slack, etc.
    }
  } catch (err) {
    console.error("[Monitor] Integrity check failed:", err);
  }
}, 5 * 60 * 1000); // Every 5 minutes

console.log("Production wallet initialized.");
console.log("Address:", await wallet.getAddress());

// Export the wallet for use by other modules (e.g., an API server or agent loop).
export { wallet };
```

::: tip
Add the missing `TimeWindowRule` import:
```typescript
// TimeWindowRule restricts when the agent can transact (e.g., business hours only).
// Add this import alongside the others shown in the full example above.
import { TimeWindowRule } from "kova";
```
The complete import list is shown in the full example above.
:::

## Deployment Options

### Docker

```dockerfile
# Use a slim Node.js 18 base image to minimize container size and attack surface.
FROM node:18-slim

# Set the working directory inside the container.
WORKDIR /app

# Copy package.json and package-lock.json first for better Docker layer caching.
# This means npm ci only re-runs when dependencies change, not when code changes.
COPY package*.json ./

# Install production dependencies only (no devDependencies).
# npm ci uses the lockfile for reproducible builds.
RUN npm ci --production

# Copy the compiled JavaScript from the dist/ directory.
# (You should compile TypeScript to JS before building the Docker image.)
COPY dist/ ./dist/

# Declare /data as a Docker volume for the SQLite database.
# This ensures the database persists across container restarts and upgrades.
VOLUME /data

# Set the default database path to the mounted volume.
# Other environment variables (SOLANA_SECRET_KEY, SOLANA_RPC_URL, etc.)
# should be passed at runtime via docker run --env or docker-compose.
ENV WALLET_DB_PATH=/data/kova.db

# Start the wallet agent process.
CMD ["node", "dist/index.js"]
```

### PM2

```json
{
  "apps": [{
    // Human-readable name shown in PM2 process list and logs.
    "name": "wallet-agent",

    // Path to the compiled JavaScript entry point.
    "script": "dist/index.js",

    // IMPORTANT: Always run exactly 1 instance.
    // Multiple instances accessing the same SQLite database can cause corruption.
    // If you need high availability, use a distributed database with locking.
    "instances": 1,

    // Restart up to 10 times if the process crashes.
    // After 10 restarts, PM2 stops trying (prevents infinite restart loops).
    "max_restarts": 10,

    // Wait 5 seconds between restart attempts to avoid hammering resources.
    "restart_delay": 5000,

    // Environment variables passed to the process.
    // Sensitive values (SOLANA_SECRET_KEY, TELEGRAM_BOT_TOKEN, etc.)
    // should be loaded from a .env file or secrets manager, not hardcoded here.
    "env": {
      "NODE_ENV": "production",
      "WALLET_DB_PATH": "/var/data/kova.db"
    }
  }]
}
```

::: warning
Always run a single instance of the wallet agent. Running multiple instances against the same SQLite database can cause corruption. If you need high availability, use a proper distributed database and implement distributed locking (<Term id="mutex" />).
:::

## Common Mistakes

1. **Using `MemoryStore` in production.** This is the most common mistake. With `MemoryStore`, every process restart resets all spending counters, rate limit windows, and audit log entries. Your daily spending limit effectively becomes unlimited because the counter resets on every deploy. Always use `SqliteStore` for production.

2. **Running multiple instances of the wallet agent.** SQLite is designed for single-writer scenarios. If you run two instances of your wallet agent pointing at the same database file, you will get database locking errors and potentially corrupt data. Use `instances: 1` in PM2 and avoid horizontal scaling without a distributed database.

3. **Hardcoding secrets in source code.** Never put your `SOLANA_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, or `ANTHROPIC_API_KEY` directly in your TypeScript files. Use environment variables, a `.env` file (excluded from version control), or a secrets manager like AWS Secrets Manager or HashiCorp Vault.

## Troubleshooting

### Server not starting

- **Port conflict:** If you see `EADDRINUSE`, another process is using the same port. Change the `PORT` environment variable or stop the conflicting process with `lsof -i :3000` to find it and `kill <PID>` to stop it.
- **Missing environment variables:** The `loadConfig()` pattern shown above will throw immediately with a clear message like `Missing required environment variable: SOLANA_SECRET_KEY`. Check that all required variables are set in your environment.
- **Database directory does not exist:** `SqliteStore` creates the database file but not the parent directory. If you specify `path: "/var/data/kova.db"`, the `/var/data/` directory must already exist. Create it with `mkdir -p /var/data/`.

### Circuit breaker keeps opening

- The circuit breaker opens after consecutive **policy denials**, not chain errors. If your agent keeps trying transactions that violate the policy, the breaker opens to prevent spam. Check your agent's behavior and ensure it respects policy constraints (e.g., checking `wallet_get_policy` before attempting transactions).
- Reduce the `threshold` for testing (e.g., `threshold: 3`) and increase `cooldownMs` (e.g., `cooldownMs: 300_000` for 5 minutes) to give yourself time to investigate.

### Audit integrity check fails

- This means one or more entries in the SHA-256 hash chain have been modified or deleted. This is a serious issue in production. Possible causes: manual database edits, a bug in a data migration script, or a compromised system. Investigate immediately.
- If you are seeing this in development, it may be because you deleted or modified the SQLite database file directly. The hash chain expects entries to be immutable once written.

## What to Try Next

- **Set up a Slack alert webhook.** Replace the `sendSlackAlert` placeholder in the audit failure callback with a real Slack incoming webhook. Test it by intentionally causing an audit write failure (e.g., by making the database file read-only temporarily).
- **Create a health monitoring dashboard.** Build a simple web page that calls your `/health` endpoint every 30 seconds and displays the wallet address, policy name, and latest transaction.
- **Practice a disaster recovery scenario.** Restore from a database backup, verify audit integrity, and confirm that spending counters are correct.

## Next Steps

- [API Reference](/api/reference) -- Full configuration options for every component
- [Policy Cookbook](/tutorials/policy-cookbook) -- Fine-tune your production policy
- [Telegram Approval](/tutorials/telegram-approval) -- Detailed approval channel setup
