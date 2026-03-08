import { describe, it, expect } from "vitest";
import {
  isTransferIntent,
  isSwapIntent,
  isMintIntent,
  isStakeIntent,
  isCustomIntent,
} from "../../../src/core/intent.js";
import type {
  TransactionIntent,
  TransferParams,
  SwapParams,
  MintParams,
  StakeParams,
  CustomParams,
} from "../../../src/core/intent.js";

describe("Intent Type Guards", () => {
  const transferIntent: TransactionIntent = {
    type: "transfer",
    chain: "solana",
    params: { to: "recipient123", amount: "1.5", token: "SOL" } as TransferParams,
  };

  const swapIntent: TransactionIntent = {
    type: "swap",
    chain: "solana",
    params: { fromToken: "SOL", toToken: "USDC", amount: "10" } as SwapParams,
  };

  const mintIntent: TransactionIntent = {
    type: "mint",
    chain: "solana",
    params: {
      collection: "collection123",
      metadataUri: "https://example.com/metadata.json",
    } as MintParams,
  };

  const stakeIntent: TransactionIntent = {
    type: "stake",
    chain: "solana",
    params: { amount: "5.0", token: "SOL", validator: "validator123" } as StakeParams,
  };

  const customIntent: TransactionIntent = {
    type: "custom",
    chain: "solana",
    params: {
      programId: "program123",
      data: "base64data",
      accounts: [{ address: "addr1", isSigner: true, isWritable: true }],
    } as CustomParams,
  };

  describe("isTransferIntent", () => {
    it("should return true for transfer intent", () => {
      expect(isTransferIntent(transferIntent)).toBe(true);
    });

    it("should return false for non-transfer intents", () => {
      expect(isTransferIntent(swapIntent)).toBe(false);
      expect(isTransferIntent(mintIntent)).toBe(false);
      expect(isTransferIntent(stakeIntent)).toBe(false);
      expect(isTransferIntent(customIntent)).toBe(false);
    });

    it("should narrow type to TransferParams", () => {
      if (isTransferIntent(transferIntent)) {
        // TypeScript should allow access to TransferParams fields
        expect(transferIntent.params.to).toBe("recipient123");
        expect(transferIntent.params.amount).toBe("1.5");
        expect(transferIntent.params.token).toBe("SOL");
      }
    });
  });

  describe("isSwapIntent", () => {
    it("should return true for swap intent", () => {
      expect(isSwapIntent(swapIntent)).toBe(true);
    });

    it("should return false for non-swap intents", () => {
      expect(isSwapIntent(transferIntent)).toBe(false);
      expect(isSwapIntent(mintIntent)).toBe(false);
      expect(isSwapIntent(stakeIntent)).toBe(false);
      expect(isSwapIntent(customIntent)).toBe(false);
    });

    it("should narrow type to SwapParams", () => {
      if (isSwapIntent(swapIntent)) {
        expect(swapIntent.params.fromToken).toBe("SOL");
        expect(swapIntent.params.toToken).toBe("USDC");
        expect(swapIntent.params.amount).toBe("10");
      }
    });
  });

  describe("isMintIntent", () => {
    it("should return true for mint intent", () => {
      expect(isMintIntent(mintIntent)).toBe(true);
    });

    it("should return false for non-mint intents", () => {
      expect(isMintIntent(transferIntent)).toBe(false);
      expect(isMintIntent(swapIntent)).toBe(false);
      expect(isMintIntent(stakeIntent)).toBe(false);
      expect(isMintIntent(customIntent)).toBe(false);
    });

    it("should narrow type to MintParams", () => {
      if (isMintIntent(mintIntent)) {
        expect(mintIntent.params.collection).toBe("collection123");
        expect(mintIntent.params.metadataUri).toBe("https://example.com/metadata.json");
      }
    });
  });

  describe("isStakeIntent", () => {
    it("should return true for stake intent", () => {
      expect(isStakeIntent(stakeIntent)).toBe(true);
    });

    it("should return false for non-stake intents", () => {
      expect(isStakeIntent(transferIntent)).toBe(false);
      expect(isStakeIntent(swapIntent)).toBe(false);
      expect(isStakeIntent(mintIntent)).toBe(false);
      expect(isStakeIntent(customIntent)).toBe(false);
    });

    it("should narrow type to StakeParams", () => {
      if (isStakeIntent(stakeIntent)) {
        expect(stakeIntent.params.amount).toBe("5.0");
        expect(stakeIntent.params.token).toBe("SOL");
        expect(stakeIntent.params.validator).toBe("validator123");
      }
    });
  });

  describe("isCustomIntent", () => {
    it("should return true for custom intent", () => {
      expect(isCustomIntent(customIntent)).toBe(true);
    });

    it("should return false for non-custom intents", () => {
      expect(isCustomIntent(transferIntent)).toBe(false);
      expect(isCustomIntent(swapIntent)).toBe(false);
      expect(isCustomIntent(mintIntent)).toBe(false);
      expect(isCustomIntent(stakeIntent)).toBe(false);
    });

    it("should narrow type to CustomParams", () => {
      if (isCustomIntent(customIntent)) {
        expect(customIntent.params.programId).toBe("program123");
        expect(customIntent.params.data).toBe("base64data");
        expect(customIntent.params.accounts).toHaveLength(1);
      }
    });
  });

  describe("Intent with optional fields", () => {
    it("should work with intents that have metadata", () => {
      const intentWithMeta: TransactionIntent = {
        type: "transfer",
        chain: "solana",
        params: { to: "addr1", amount: "1", token: "SOL" } as TransferParams,
        metadata: {
          reason: "Payment for service",
          agentId: "agent-1",
          taskId: "task-42",
        },
        id: "intent-123",
        createdAt: Date.now(),
      };

      expect(isTransferIntent(intentWithMeta)).toBe(true);
    });

    it("should work with intents on different chains", () => {
      const ethIntent: TransactionIntent = {
        type: "transfer",
        chain: "ethereum",
        params: { to: "0xabc", amount: "0.1", token: "ETH" } as TransferParams,
      };

      expect(isTransferIntent(ethIntent)).toBe(true);
    });

    it("should work with swap intent with optional slippage", () => {
      const swapWithSlippage: TransactionIntent = {
        type: "swap",
        chain: "solana",
        params: {
          fromToken: "SOL",
          toToken: "USDC",
          amount: "10",
          maxSlippage: 0.01,
        } as SwapParams,
      };

      expect(isSwapIntent(swapWithSlippage)).toBe(true);
      if (isSwapIntent(swapWithSlippage)) {
        expect(swapWithSlippage.params.maxSlippage).toBe(0.01);
      }
    });
  });
});
