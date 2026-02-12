# Production Deployment

This guide covers hardening your agent wallet for production use. You will learn how to switch from in-memory storage to persistent SQLite, configure <Term id="circuit-breaker">circuit breakers</Term>, set up monitoring and alerting, and follow security best practices.

## Prerequisites

- A working agent wallet (see [Your First Agent Wallet](/tutorials/first-wallet))
- Familiarity with the policy system (see [Policy Cookbook](/tutorials/policy-cookbook))

## 1. Switch from MemoryStore to SqliteStore

`MemoryStore` loses all data when your process restarts. For production, use `SqliteStore` which persists spending counters, rate limit windows, and audit logs to a SQLite database file.

```typescript
import { SqliteStore } from "kova";

const store = new SqliteStore({
  path: "./data/kova.db",
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

## 2. Configure a Circuit Breaker

The circuit breaker stops all transactions if too many consecutive failures occur. This protects against cascading failures, RPC outages, or unexpected errors.

```typescript
import { AgentWallet, LocalSigner, SolanaAdapter, PolicyEngine, AuditLogger } from "kova";

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
  circuitBreaker: {
    threshold: 5,       // 5 consecutive denials before circuit opens
    cooldownMs: 60_000, // 1 minute cooldown
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

const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    // Send alert via your preferred channel
    console.error("[CRITICAL] Audit failure:", error.message);

    // Example: send to Slack
    sendSlackAlert({
      channel: "#wallet-alerts",
      text: `Audit failure in kova: ${error.message}`,
      severity: "critical",
    });

    // Example: send to PagerDuty
    triggerPagerDuty({
      summary: `kova audit integrity failure`,
      details: error.message,
    });
  },
});
```

You can also pass the `onAuditFailure` callback directly to the `AgentWallet` constructor:

```typescript
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    console.error("[CRITICAL] Audit failure:", error.message);
    // Trigger alerts...
  },
});
```

## 4. Environment Variable Management

Never hardcode sensitive values. Use a structured configuration pattern:

```typescript
interface WalletConfig {
  solanaSecretKey: string;
  solanaRpcUrl: string;
  dbPath: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

function loadConfig(): WalletConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const optional = (name: string): string | undefined => {
    return process.env[name];
  };

  return {
    solanaSecretKey: required("SOLANA_SECRET_KEY"),
    solanaRpcUrl: required("SOLANA_RPC_URL"),
    dbPath: required("WALLET_DB_PATH"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    telegramChatId: optional("TELEGRAM_CHAT_ID"),
  };
}

const config = loadConfig();
```

::: danger
Never log secret keys. Never commit `.env` files. Use a secrets manager (AWS Secrets Manager, HashiCorp Vault, Doppler, etc.) in production.
:::

## 5. Monitoring Audit Integrity

Set up periodic integrity verification to detect any tampering with the audit log's <Term id="hash-chain" />.

```typescript
import { AuditLogger } from "kova";

async function monitorIntegrity(logger: AuditLogger) {
  const report = await logger.verifyIntegrity(1000);

  console.log(`[Integrity Check] Valid: ${report.valid}`);
  console.log(`[Integrity Check] Entries checked: ${report.entriesChecked}`);

  if (!report.valid) {
    console.error(
      `[ALERT] Audit chain broken at entry: ${report.firstBrokenAt}`
    );
    // Trigger critical alert
    // Consider pausing the agent until investigated
  }

  return report;
}

// Run integrity check every 5 minutes
setInterval(async () => {
  try {
    await monitorIntegrity(logger);
  } catch (error) {
    console.error("[Integrity Monitor] Check failed:", error);
  }
}, 5 * 60 * 1000);
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

function backupDatabase(dbPath: string, backupDir: string) {
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${backupDir}/kova-${timestamp}.db`;

  copyFileSync(dbPath, backupPath);
  console.log(`Database backed up to: ${backupPath}`);

  return backupPath;
}

// Run daily backup
setInterval(() => {
  try {
    backupDatabase("./data/kova.db", "./backups");
  } catch (error) {
    console.error("Backup failed:", error);
  }
}, 24 * 60 * 60 * 1000);
```

::: warning
For production SQLite backups under write load, use the SQLite Online Backup API or `sqlite3 .backup` command to avoid backing up a database mid-write. The simple `copyFileSync` approach shown above is safe only if the database is not being written to at that moment.
:::

## 7. Log Rotation and Cleanup

Over time, the audit log and transaction history will grow. Implement a cleanup strategy:

```typescript
async function cleanupOldEntries(store: SqliteStore, maxAgeDays: number) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  // Query and archive old entries before deletion
  const oldEntries = await store.getRecent("audit_log", 10000);
  const toArchive = oldEntries.filter(
    (entry) => new Date(entry.timestamp) < cutoffDate
  );

  if (toArchive.length > 0) {
    console.log(`Archiving ${toArchive.length} entries older than ${maxAgeDays} days`);
    // Write to archive file or cold storage before cleanup
  }
}

// Run weekly cleanup, keeping 90 days of history
setInterval(() => {
  cleanupOldEntries(store, 90).catch(console.error);
}, 7 * 24 * 60 * 60 * 1000);
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
  SqliteStore,
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
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

// --- Store (persistent) ---
const store = new SqliteStore({
  path: required("WALLET_DB_PATH"),
});

// --- Signer ---
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(required("SOLANA_SECRET_KEY")))
);
const signer = new LocalSigner(keypair);

// --- Chain ---
const chain = new SolanaAdapter({
  rpcUrl: required("SOLANA_RPC_URL"),
  commitment: "confirmed",
});

// --- Approval ---
const approvalBot = new TelegramApprovalBot({
  token: required("TELEGRAM_BOT_TOKEN"),
  chatId: required("TELEGRAM_CHAT_ID"),
  defaultTimeout: 300000,
  allowedUserIds: [required("TELEGRAM_CHAT_ID")],
  pollInterval: 2000,
});

// --- Policy ---
const policy = Policy.create("production-policy")
  .spendingLimit({
    perTransaction: { amount: "5.0", token: "SOL" },
    daily: { amount: "50.0", token: "SOL" },
  })
  .allowAddresses([
    required("ALLOWED_ADDRESS_1"),
    required("ALLOWED_ADDRESS_2"),
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .activeHours({
    timezone: "America/New_York",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "17:00",
      },
    ],
  })
  .requireApproval({
    above: { amount: "2.0", token: "SOL" },
    channel: "telegram",
    timeout: 300_000,
  })
  .build();

const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new AllowlistRule({
    allowAddresses: config.allowAddresses,
  }),
  new RateLimitRule(config.rateLimit!),
  new TimeWindowRule(config.activeHours!),
  new ApprovalGateRule(config.approvalGate!),
];
const engine = new PolicyEngine(rules, store, approvalBot);

// --- Audit Logger ---
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    console.error("[CRITICAL] Audit failure:", error.message);
    // Send to your alerting system
  },
});

// --- Wallet ---
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval: approvalBot,
  logger,
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 60_000,
  },
  onAuditFailure: (error: unknown, consecutiveFailures: number) => {
    console.error("[CRITICAL] Wallet audit failure:", error.message);
  },
});

// --- Monitoring ---
setInterval(async () => {
  try {
    const report = await logger.verifyIntegrity(1000);
    if (!report.valid) {
      console.error(`[ALERT] Audit broken at entry ${report.firstBrokenAt}`);
    }
  } catch (err) {
    console.error("[Monitor] Integrity check failed:", err);
  }
}, 5 * 60 * 1000); // Every 5 minutes

console.log("Production wallet initialized.");
console.log("Address:", await wallet.getAddress());

export { wallet };
```

::: tip
Add the missing `TimeWindowRule` import:
```typescript
import { TimeWindowRule } from "kova";
```
The complete import list is shown in the full example above.
:::

## Deployment Options

### Docker

```dockerfile
FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
VOLUME /data
ENV WALLET_DB_PATH=/data/kova.db
CMD ["node", "dist/index.js"]
```

### PM2

```json
{
  "apps": [{
    "name": "wallet-agent",
    "script": "dist/index.js",
    "instances": 1,
    "max_restarts": 10,
    "restart_delay": 5000,
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

## Next Steps

- [API Reference](/api/reference) -- Full configuration options for every component
- [Policy Cookbook](/tutorials/policy-cookbook) -- Fine-tune your production policy
- [Telegram Approval](/tutorials/telegram-approval) -- Detailed approval channel setup
