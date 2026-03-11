---
layout: home

hero:
  name: "kova"
  text: "Secure Crypto Wallets for AI Agents"
  tagline: "Give your AI agent the ability to transact on the blockchain -- without giving it the keys. kova is a TypeScript SDK that enforces policy constraints on every transaction, so autonomous agents can spend within the rules you define."
  image:
    src: /logo.svg
    alt: kova
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/how-it-works
    - theme: alt
      text: View on GitHub
      link: https://github.com/kova-wallet/kova

features:
  - title: "AgentWallet -- One Object, Full Control"
    details: "The AgentWallet class is the single entry point your AI agent interacts with. It orchestrates signing, policy enforcement, chain interaction, and audit logging behind one simple execute() call. Your agent sees tool schemas; your server holds the keys."
    icon: "\U0001F4BC"
  - title: "Intent-Based Transactions"
    details: "Agents describe what they want (transfer 1 SOL to Alice), not how to do it. Five intent types -- transfer, swap, mint, stake, custom -- cover all common blockchain operations. The SDK handles instruction building, signing, and broadcasting."
    icon: "\U0001F4DD"
  - title: "Policy Engine -- Deny by Default"
    details: "Every transaction passes through an ordered chain of policy rules before execution. Spending limits, rate limits, address allowlists, time windows, and human approval gates. Fail-closed design: if anything goes wrong, the transaction is denied."
    icon: "\U0001F6E1\uFE0F"
  - title: "AI Framework Integration"
    details: "First-class tool definitions for Claude (Anthropic), OpenAI, and LangChain. One call to toAnthropicTools(), toOpenAITools(), or createLangChainTools() gives your agent structured tool schemas. Policy enforcement is transparent to the agent."
    icon: "\U0001F916"
  - title: "Human Approval Gates"
    details: "High-value transactions can require human sign-off before execution. Pluggable approval channels (callback-based or webhook-based) send approval requests with configurable thresholds, timeouts, and HMAC-signed payloads. No response means denial."
    icon: "\u2705"
  - title: "Tamper-Evident Audit Trail"
    details: "Every policy decision and transaction is recorded in a SHA-256 hash chain with HMAC integrity verification. Each entry references the previous hash, making it impossible to alter history undetected. A circuit breaker halts all transactions if audit logging fails."
    icon: "\U0001F50D"
  - title: "Solana with Pyth Oracles"
    details: "Full Solana support: native SOL transfers, SPL token transfers, and token swaps. Built-in Pyth oracle integration for on-chain price feeds with configurable staleness and confidence thresholds. Chain-agnostic architecture means more chains can be added without changing your code."
    icon: "\u26A1"
  - title: "TypeScript with Strict Mode"
    details: "Written entirely in TypeScript with strict mode enabled. Full type safety across intents, policies, results, and tool definitions. Every function parameter, return type, and configuration object is typed so your editor catches mistakes before your code runs."
    icon: "\U0001F4E6"
---
