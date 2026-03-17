# OpenAI Integration

::: info
kova uses **MCP (Model Context Protocol)** as its sole agent interface. Any OpenAI agent or tool-calling workflow that supports MCP can connect to the kova wallet server.
:::

## Setup

Connect an OpenAI-based agent to kova via the MCP server:

```typescript
import {
  AgentWallet, Policy, LocalSigner, MemoryStore, SolanaAdapter,
  createMcpServer,
} from "@kova/wallet";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 1. Configure the wallet
const wallet = new AgentWallet({ signer, chain, policy, store });

// 2. Create and start the MCP server
const server = createMcpServer(wallet);
await server.connect(new StdioServerTransport());
```

The MCP server exposes all wallet tools (transfers, balance checks, swaps, etc.) and any MCP-compatible OpenAI client can discover and call them. Policy enforcement is automatic and transparent.

## How It Works

1. Your OpenAI agent connects to the kova MCP server
2. The agent discovers available tools via the MCP `listTools` method
3. When the agent calls a tool, the MCP server validates inputs, enforces policies, and executes the operation
4. Results are returned through the MCP protocol with sanitized error messages

## Further Reading

- [AI Integration Overview](./overview.md) -- Full MCP server configuration, options, and all available tools
- [Server Setup](/guide/server-setup) -- Run the MCP server as a service
