import { describe, it, expect } from "vitest";
import { MPCSigner } from "../../../src/signers/mpc.js";

describe("MPCSigner", () => {
  const defaultConfig = {
    provider: "lit-protocol",
    keyId: "key-123",
    threshold: 2,
  };

  it("should instantiate without errors", () => {
    const signer = new MPCSigner(defaultConfig);
    expect(signer).toBeDefined();
  });

  it("should throw 'not yet implemented' for getAddress()", async () => {
    const signer = new MPCSigner(defaultConfig);
    await expect(signer.getAddress()).rejects.toThrow("not yet implemented");
  });

  it("should throw 'not yet implemented' for sign()", async () => {
    const signer = new MPCSigner(defaultConfig);
    await expect(
      signer.sign({
        chain: "solana",
        data: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow("not yet implemented");
  });

  it("should return false for healthCheck()", async () => {
    const signer = new MPCSigner(defaultConfig);
    expect(await signer.healthCheck()).toBe(false);
  });

  it("should accept different provider configurations", () => {
    const fireblocksSigner = new MPCSigner({
      provider: "fireblocks",
      keyId: "fb-key-456",
      threshold: 3,
    });
    expect(fireblocksSigner).toBeDefined();
  });
});
