# LangChain Integration

::: info
kova uses **MCP (Model Context Protocol)** as its sole agent interface. LangChain agents can connect to the kova MCP server using LangChain's MCP tool integration.
:::

## Setup

Connect a LangChain agent to kova via the MCP server:

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

LangChain's MCP integration allows any LangChain agent to discover and call the wallet tools exposed by the MCP server. Policy enforcement happens automatically on every tool call.

## How It Works

1. Your LangChain agent connects to the kova MCP server via an MCP client
2. The agent discovers available tools via the MCP `listTools` method
3. Tools are automatically converted to LangChain-compatible tool definitions
4. When the agent calls a tool, the MCP server validates, enforces policies, and executes

## Further Reading

- [AI Integration Overview](./overview.md) -- Full MCP server configuration, options, and all available tools
- [Server Setup](/guide/server-setup) -- Run the MCP server as a service
