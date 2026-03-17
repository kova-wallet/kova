# Claude (Anthropic) Integration

::: info
kova uses **MCP (Model Context Protocol)** as its sole agent interface. Claude has first-class MCP support -- connect your kova MCP server and Claude can discover and call wallet tools automatically.
:::

## Setup

Claude Desktop and the Claude API both support MCP. To connect a kova wallet to Claude:

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet, Policy, LocalSigner, MemoryStore, SolanaAdapter,
  createMcpStdioServer,
} from "@kova/wallet";

// 1. Configure the wallet
const signer = new LocalSigner(Keypair.generate());
const store = new MemoryStore();
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com", network: "devnet" });

const policy = Policy.create("claude-agent")
  .spendingLimit({ perTransaction: { amount: "10", token: "SOL" }, daily: { amount: "50", token: "SOL" } })
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .build();

const wallet = new AgentWallet({ signer, chain, policy, store });

// 2. Start the MCP server on stdio
const server = await createMcpStdioServer(wallet);
// Claude connects via MCP and can now call wallet tools
```

## Claude Desktop Configuration

Add the kova MCP server to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kova-wallet": {
      "command": "node",
      "args": ["path/to/your/mcp-server.js"]
    }
  }
}
```

Claude will automatically discover the wallet tools (`wallet_transfer`, `wallet_get_balance`, etc.) and can call them based on user requests. Policy enforcement happens transparently on every tool call.

## System Prompt Recommendations

The system prompt guides Claude's behavior but is **not a security boundary** -- the policy engine enforces hard limits.

```
You are a financial assistant managing a crypto wallet.

RULES:
- ALWAYS call wallet_get_policy before your first transaction to understand your constraints.
- NEVER attempt a transfer without first checking wallet_get_balance for sufficient funds.
- If a transaction is denied by policy, explain the denial. Do NOT retry the same transaction.
- Always include a "reason" field in transfer/swap calls for the audit trail.
```

## Further Reading

- [AI Integration Overview](./overview.md) -- Full MCP server configuration and all available tools
- [Server Setup](/guide/server-setup) -- Run the MCP server as a service
- [Claude Agent Tutorial](/tutorials/claude-agent-integration) -- Step-by-step tutorial
