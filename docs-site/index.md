---
layout: home

hero:
  name: "kova"
  text: "Secure Crypto Wallets for AI Agents"
  tagline: "Policy-constrained crypto wallet SDK for AI agents"
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/how-it-works
    - theme: alt
      text: View on GitHub
      link: https://github.com/kova-wallet/kova

features:
  - title: Policy Engine
    details: Composable rules for spending limits, rate limits, allowlists, time windows, and approval gates. Every transaction is evaluated before execution. Deny-by-default, fail-closed design.
    icon: "\U0001F6E1\uFE0F"
  - title: AI Integration
    details: First-class tool definitions for Claude (Anthropic), OpenAI, and LangChain. Agents interact through structured tool calls — the SDK handles policy enforcement transparently.
    icon: "\U0001F916"
  - title: Human Approval
    details: Built-in Telegram bot for human-in-the-loop approval of high-value transactions. Configurable thresholds, timeouts, and user whitelisting. Fail-closed on timeout.
    icon: "\u2705"
  - title: Audit Logging
    details: Every policy decision and transaction is recorded in a SHA-256 hash chain. Tamper-evident audit trail with integrity verification. Circuit breaker blocks transactions when audit is down.
    icon: "\U0001F4DD"
  - title: Solana Support
    details: Full Solana integration including native SOL transfers, SPL token transfers, and Jupiter DEX swaps. Real RPC interaction with configurable commitment levels.
    icon: "\u26A1"
  - title: TypeScript First
    details: Written entirely in TypeScript with strict mode. Full type safety across intents, policies, results, and tool definitions. Zero runtime type surprises.
    icon: "\U0001F4E6"
---
