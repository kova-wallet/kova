# Contributing to kova

Thanks for your interest in contributing to kova! This guide covers everything you need to get started.

## Prerequisites

- Node.js 20+
- npm
- Git

## Setup

```bash
git clone https://github.com/kova-wallet/kova.git
cd kova
npm install
```

## Development workflow

```bash
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run test         # Run all tests
npm run test:watch   # Run tests in watch mode
npm run build        # Compile to dist/
```

All four checks must pass before submitting a PR.

## Running tests

```bash
npm run test                # All tests
npm run test:coverage       # With coverage report
npx vitest run tests/unit   # Unit tests only
npx vitest run tests/e2e    # E2E tests only
```

Tests use `MemoryStore` and mock chain adapters — no network access or real funds needed.

## Project structure

```
src/
  core/           # AgentWallet, intent types, circuit breaker
  policy/         # Policy engine, builder, and rules
  signers/        # Signer interface + implementations
  stores/         # Store interface + MemoryStore, SqliteStore
  chains/         # Chain adapter interface + Solana implementation
  approval/       # Approval channel interface + Telegram bot
  adapters/       # LLM tool definitions (Claude, OpenAI, LangChain)
  logging/        # Audit logger with hash-chain integrity
tests/
  unit/           # Unit tests (mirrors src/ structure)
  e2e/            # End-to-end workflow tests
  integration/    # Integration tests (SQLite, circuit breaker)
dashboard/        # Next.js admin UI
docs-site/        # VitePress documentation
```

## Submitting a PR

1. Fork the repo and create a branch from `dev`
2. Make your changes
3. Run `npm run typecheck && npm run lint && npm run test` — all must pass
4. Submit a PR targeting the `dev` branch
5. Fill out the PR template

## Code style

- TypeScript strict mode is enabled
- ESLint and Prettier are configured — run `npm run lint:fix` and `npm run format` to auto-fix
- Prefer explicit types over `any`
- All public API changes need tests

## Security

If you discover a security vulnerability, **do not** open a public issue. Instead, report it via [GitHub Security Advisory](https://github.com/kova-wallet/kova/security/advisories/new).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
