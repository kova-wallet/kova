/**
 * Canonical tool definitions for all wallet operations.
 * Framework-agnostic — adapters convert these to provider-specific formats.
 */

import type { ToolDefinition } from "./types.js";

/** All wallet tool names as a const union for type-safe dispatch */
export const WALLET_TOOL_NAMES = [
  "wallet_transfer",
  "wallet_swap",
  "wallet_mint",
  "wallet_stake",
  "wallet_execute_custom",
  "wallet_get_balance",
  "wallet_get_policy",
  "wallet_get_transaction_history",
] as const;

export type WalletToolName = (typeof WALLET_TOOL_NAMES)[number];

export const WALLET_TOOLS: readonly ToolDefinition[] = [
  {
    name: "wallet_transfer",
    description:
      "Transfer tokens to a recipient address. Sends a specified amount of a token (e.g., SOL, USDC) to the given address on the configured chain.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient wallet address",
        },
        amount: {
          type: "string",
          description: 'Amount to send as a decimal string (e.g., "1.5")',
        },
        token: {
          type: "string",
          description: 'Token symbol (e.g., "SOL", "USDC") or mint address',
        },
        chain: {
          type: "string",
          description: "Target blockchain",
          enum: ["solana", "ethereum", "base"],
        },
        reason: {
          type: "string",
          description: "Why this transfer is being made (for audit trail)",
        },
      },
      required: ["to", "amount", "token", "chain"],
    },
  },
  {
    name: "wallet_swap",
    description:
      "Swap one token for another. Executes a token swap on the configured chain (e.g., SOL to USDC via Jupiter on Solana).",
    parameters: {
      type: "object",
      properties: {
        fromToken: {
          type: "string",
          description: 'Token to sell (e.g., "SOL")',
        },
        toToken: {
          type: "string",
          description: 'Token to buy (e.g., "USDC")',
        },
        amount: {
          type: "string",
          description:
            'Amount of fromToken to sell as a decimal string (e.g., "5.0")',
        },
        maxSlippage: {
          type: "number",
          description:
            "Maximum slippage tolerance as a decimal (e.g., 0.01 for 1%). Defaults to 0.5%",
        },
        chain: {
          type: "string",
          description: "Target blockchain",
          enum: ["solana", "ethereum", "base"],
        },
        reason: {
          type: "string",
          description: "Why this swap is being made (for audit trail)",
        },
      },
      required: ["fromToken", "toToken", "amount", "chain"],
    },
  },
  {
    name: "wallet_mint",
    description:
      "Mint an NFT from a collection. Creates a new NFT using the specified collection address and metadata URI.",
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "Collection or program address",
        },
        metadataUri: {
          type: "string",
          description: "Metadata URI for the NFT",
        },
        to: {
          type: "string",
          description:
            "Recipient address (defaults to this wallet's address if not specified)",
        },
        chain: {
          type: "string",
          description: "Target blockchain",
          enum: ["solana", "ethereum", "base"],
        },
        reason: {
          type: "string",
          description: "Why this mint is being made (for audit trail)",
        },
      },
      required: ["collection", "metadataUri", "chain"],
    },
  },
  {
    name: "wallet_stake",
    description:
      "Stake tokens with a validator or staking pool. Locks the specified amount of tokens for staking rewards.",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: 'Amount to stake as a decimal string (e.g., "100")',
        },
        token: {
          type: "string",
          description: 'Token to stake (e.g., "SOL")',
        },
        validator: {
          type: "string",
          description:
            "Validator or staking pool address (optional, uses default if omitted)",
        },
        chain: {
          type: "string",
          description: "Target blockchain",
          enum: ["solana", "ethereum", "base"],
        },
        reason: {
          type: "string",
          description: "Why this stake is being made (for audit trail)",
        },
      },
      required: ["amount", "token", "chain"],
    },
  },
  {
    name: "wallet_execute_custom",
    description:
      "Execute a custom on-chain program instruction. For advanced use cases not covered by transfer, swap, mint, or stake.",
    parameters: {
      type: "object",
      properties: {
        programId: {
          type: "string",
          description: "Program or contract address to interact with",
        },
        data: {
          type: "string",
          description: "Instruction data (base64 encoded)",
        },
        accounts: {
          type: "string",
          description:
            'JSON array of account objects, each with { "address": string, "isSigner": boolean, "isWritable": boolean }',
        },
        chain: {
          type: "string",
          description: "Target blockchain",
          enum: ["solana", "ethereum", "base"],
        },
        reason: {
          type: "string",
          description:
            "Why this instruction is being executed (for audit trail)",
        },
      },
      required: ["programId", "data", "accounts", "chain"],
    },
  },
  {
    name: "wallet_get_balance",
    description:
      "Get the wallet's balance for a specific token. Returns the current balance amount, decimals, and USD value if available.",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description:
            'Token symbol to check balance for (e.g., "SOL", "USDC")',
        },
      },
      required: ["token"],
    },
  },
  {
    name: "wallet_get_policy",
    description:
      "Get a summary of the current policy constraints. Shows spending limits, rate limits, allowlisted addresses, approval thresholds, and active hours. Use this to understand what transactions are allowed before attempting them.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "wallet_get_transaction_history",
    description:
      "Get recent transaction history. Returns the most recent transactions with their status, amounts, and timestamps.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of transactions to return (default: 10, max: 1000)",
        },
      },
      required: [],
    },
  },
];

/** Look up a tool definition by name */
export function getToolByName(name: string): ToolDefinition | undefined {
  return WALLET_TOOLS.find((t) => t.name === name);
}
