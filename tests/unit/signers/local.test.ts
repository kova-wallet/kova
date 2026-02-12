import { describe, it, expect } from "vitest";
import { LocalSigner } from "../../../src/signers/local.js";
import { Keypair } from "@solana/web3.js";

describe("LocalSigner", () => {
  it("should return a valid base58 address", async () => {
    const keypair = Keypair.generate();
    const signer = new LocalSigner(keypair);
    const address = await signer.getAddress();

    expect(address).toBe(keypair.publicKey.toBase58());
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("should produce deterministic address from same keypair", async () => {
    const keypair = Keypair.generate();
    const signer = new LocalSigner(keypair);

    const addr1 = await signer.getAddress();
    const addr2 = await signer.getAddress();
    expect(addr1).toBe(addr2);
  });

  it("should always pass healthCheck", async () => {
    const signer = new LocalSigner(Keypair.generate());
    expect(await signer.healthCheck()).toBe(true);
  });

  it("should reject non-solana chain in sign()", async () => {
    const signer = new LocalSigner(Keypair.generate());
    await expect(
      signer.sign({
        chain: "ethereum",
        data: new Uint8Array(),
      }),
    ).rejects.toThrow("LocalSigner only supports Solana");
  });

  it("should reject 'base' chain in sign()", async () => {
    const signer = new LocalSigner(Keypair.generate());
    await expect(
      signer.sign({
        chain: "base",
        data: new Uint8Array(),
      }),
    ).rejects.toThrow("LocalSigner only supports Solana");
  });

  it("should reject empty string chain in sign()", async () => {
    const signer = new LocalSigner(Keypair.generate());
    await expect(
      signer.sign({
        chain: "",
        data: new Uint8Array(),
      }),
    ).rejects.toThrow("LocalSigner only supports Solana");
  });

  it("should produce different addresses from different keypairs", async () => {
    const signer1 = new LocalSigner(Keypair.generate());
    const signer2 = new LocalSigner(Keypair.generate());

    const addr1 = await signer1.getAddress();
    const addr2 = await signer2.getAddress();
    expect(addr1).not.toBe(addr2);
  });

  it("should return the same address from same secret key", async () => {
    const original = Keypair.generate();
    const restored = Keypair.fromSecretKey(original.secretKey);

    const signer1 = new LocalSigner(original);
    const signer2 = new LocalSigner(restored);

    expect(await signer1.getAddress()).toBe(await signer2.getAddress());
  });

  it("should return address with length between 32 and 44 characters", async () => {
    // Generate several keypairs to test address length distribution
    for (let i = 0; i < 10; i++) {
      const signer = new LocalSigner(Keypair.generate());
      const address = await signer.getAddress();
      expect(address.length).toBeGreaterThanOrEqual(32);
      expect(address.length).toBeLessThanOrEqual(44);
    }
  });

  it("should not contain ambiguous characters (0, O, I, l) in address", async () => {
    // Base58 encoding specifically excludes 0, O, I, l
    for (let i = 0; i < 10; i++) {
      const signer = new LocalSigner(Keypair.generate());
      const address = await signer.getAddress();
      expect(address).not.toMatch(/[0OIl]/);
    }
  });

  it("should handle healthCheck being called multiple times", async () => {
    const signer = new LocalSigner(Keypair.generate());
    expect(await signer.healthCheck()).toBe(true);
    expect(await signer.healthCheck()).toBe(true);
    expect(await signer.healthCheck()).toBe(true);
  });

  it("should include chain error message with the actual chain name", async () => {
    const signer = new LocalSigner(Keypair.generate());
    try {
      await signer.sign({ chain: "polygon", data: new Uint8Array() });
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("polygon");
    }
  });

  it("should accept optional description in UnsignedTransaction", async () => {
    const signer = new LocalSigner(Keypair.generate());
    // Even though it will fail to deserialize, the chain check happens first
    // for non-solana chains
    await expect(
      signer.sign({
        chain: "ethereum",
        data: new Uint8Array([1, 2, 3]),
        description: "Test transfer of 1 ETH",
      }),
    ).rejects.toThrow("LocalSigner only supports Solana");
  });
});
