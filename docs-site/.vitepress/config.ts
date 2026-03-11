import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'kova',
  description: 'Policy-constrained crypto wallet SDK for AI agents',
  base: '/kova/',
  head: [['link', { rel: 'icon', href: '/kova/logo.svg' }]],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/getting-started/how-it-works' },
      { text: 'Tutorials', link: '/tutorials/first-wallet' },
      { text: 'API', link: '/api/reference' },
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'How It Works', link: '/getting-started/how-it-works' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Core Concepts', link: '/getting-started/concepts' },
          ],
        },
      ],

      '/guide/': [
        {
          text: 'Core',
          items: [
            { text: 'AgentWallet', link: '/guide/wallet' },
            { text: 'Transaction Intents', link: '/guide/intents' },
            { text: 'Policy Engine', link: '/guide/policy-engine' },
          ],
        },
        {
          text: 'Policy Rules',
          items: [
            { text: 'Spending Limit', link: '/guide/rules/spending-limit' },
            { text: 'Allowlist', link: '/guide/rules/allowlist' },
            { text: 'Rate Limit', link: '/guide/rules/rate-limit' },
            { text: 'Time Window', link: '/guide/rules/time-window' },
            { text: 'Approval Gate', link: '/guide/rules/approval-gate' },
          ],
        },
        {
          text: 'Infrastructure',
          items: [
            { text: 'Stores', link: '/guide/stores' },
            { text: 'Signers', link: '/guide/signers' },
            { text: 'Chain Adapters', link: '/guide/chain-adapters' },
            { text: 'Price Oracles', link: '/guide/oracles' },
          ],
        },
        {
          text: 'AI Integration',
          items: [
            { text: 'Server Setup', link: '/guide/server-setup' },
            { text: 'Overview', link: '/guide/ai-integration/overview' },
            { text: 'Claude (Anthropic)', link: '/guide/ai-integration/claude' },
            { text: 'OpenAI', link: '/guide/ai-integration/openai' },
            { text: 'LangChain', link: '/guide/ai-integration/langchain' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Human Approval', link: '/guide/approval' },
            { text: 'Audit Logging', link: '/guide/audit-logging' },
            { text: 'Circuit Breaker', link: '/guide/circuit-breaker' },
            { text: 'Security', link: '/guide/security' },
          ],
        },
      ],

      '/tutorials/': [
        {
          text: 'Tutorials',
          items: [
            { text: 'Your First Agent Wallet', link: '/tutorials/first-wallet' },
            { text: 'Giving Claude a Wallet', link: '/tutorials/claude-agent-integration' },
            { text: 'Payment Agent with Claude', link: '/tutorials/payment-agent' },
            { text: 'Policy Cookbook', link: '/tutorials/policy-cookbook' },
            { text: 'Custom Approval Channels', link: '/tutorials/telegram-approval' },
            { text: 'Custom Store Adapter', link: '/tutorials/custom-store' },
            { text: 'Custom Policy Rule', link: '/tutorials/custom-policy-rule' },
            { text: 'Multi-Agent Architecture', link: '/tutorials/multi-agent' },
            { text: 'MPC Signing with Turnkey', link: '/tutorials/turnkey-mpc' },
            { text: 'NFT Minting Agent', link: '/tutorials/nft-minting-agent' },
            { text: 'Portfolio Rebalancer', link: '/tutorials/portfolio-rebalancer' },
            { text: 'Tipping Bot', link: '/tutorials/tipping-bot' },
            { text: 'DeFi Agent', link: '/tutorials/defi-agent' },
            { text: 'Kova Dashboard', link: '/tutorials/dashboard' },
            { text: 'Production Deployment', link: '/tutorials/production' },
          ],
        },
      ],

      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Full Reference', link: '/api/reference' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/kova-wallet/kova' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2025 kova contributors',
    },

    editLink: {
      pattern: 'https://github.com/kova-wallet/kova/edit/prod/docs-site/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
