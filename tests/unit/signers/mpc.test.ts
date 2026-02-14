import { describe, it, expect, vi } from "vitest";
import { MpcSigner, MpcSignerError } from "../../../src/signers/mpc.js";
import type { MpcSigningProvider, MpcSignerConfig } from "../../../src/signers/mpc.js";
import { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a valid Solana public key address string for mock providers */
function validSolanaAddress(): string {
  return Keypair.generate().publicKey.toBase58();
}

/**
 * Build a minimal valid Solana VersionedTransaction (v0) that can be deserialized.
 * Returns the serialized bytes of the unsigned transaction.
 */
function buildValidSolanaTransaction(feePayer: PublicKey): Uint8Array {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: feePayer,
        lamports: 0,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return tx.serialize();
}

/**
 * Minimal RLP encoder for building valid EVM transactions in tests.
 * CRIT-T1-03 requires EVM transaction data to be valid RLP-encoded.
 */
function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return new Uint8Array([len + offset]);
  }
  // Encode length of length
  const hexLen = len.toString(16);
  const lenOfLen = Math.ceil(hexLen.length / 2);
  const result = new Uint8Array(1 + lenOfLen);
  result[0] = offset + 55 + lenOfLen;
  for (let i = lenOfLen - 1; i >= 0; i--) {
    result[1 + i] = len & 0xff;
    len >>= 8;
  }
  return result;
}

function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0]! <= 0x7f) {
    return data;
  }
  const prefix = rlpEncodeLength(data.length, 0x80);
  const result = new Uint8Array(prefix.length + data.length);
  result.set(prefix, 0);
  result.set(data, prefix.length);
  return result;
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const encoded = items.map(rlpEncodeBytes);
  const totalLen = encoded.reduce((sum, e) => sum + e.length, 0);
  const prefix = rlpEncodeLength(totalLen, 0xc0);
  const result = new Uint8Array(prefix.length + totalLen);
  result.set(prefix, 0);
  let offset = prefix.length;
  for (const e of encoded) {
    result.set(e, offset);
    offset += e.length;
  }
  return result;
}

/**
 * Build a minimal valid RLP-encoded legacy EVM transaction for tests.
 * Format: [nonce, gasPrice, gasLimit, to, value, data]
 */
function buildValidEvmTransaction(): Uint8Array {
  const nonce = new Uint8Array([0x00]);      // nonce = 0
  const gasPrice = new Uint8Array([0x09, 0x18, 0x4e, 0x72, 0xa0, 0x00]); // 10 gwei
  const gasLimit = new Uint8Array([0x52, 0x08]); // 21000
  // 20-byte "to" address
  const to = new Uint8Array(20).fill(0xab);
  const value = new Uint8Array([0x01]);      // 1 wei
  const data = new Uint8Array(0);            // empty calldata
  return rlpEncodeList([nonce, gasPrice, gasLimit, to, value, data]);
}

/** Derive an Ethereum address from a secp256k1 private key */
function deriveEvmAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false).slice(1); // uncompressed, no 04 prefix
  const hash = keccak_256(pubKey);
  return "0x" + Buffer.from(hash.slice(-20)).toString("hex");
}

/**
 * Create a valid EVM ECDSA signature for the given RLP-encoded transaction data and private key.
 * CRIT-T1-03: Returns a properly RLP-encoded signed transaction (legacy format):
 * [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 */
function signEvmData(privateKey: Uint8Array, txData: Uint8Array): { signedData: Uint8Array; signature: Uint8Array } {
  const txHash = keccak_256(txData);
  const sig = secp256k1.sign(txHash, privateKey);
  const compact = sig.toCompactRawBytes(); // 64 bytes: r + s
  const signature = new Uint8Array(65);
  signature.set(compact, 0);
  signature[64] = sig.recovery + 27; // EVM legacy v value

  // CRIT-T1-03: Build a valid RLP-encoded signed transaction.
  // Decode the original unsigned transaction fields and re-encode with v, r, s appended.
  const outer = rlpDecodeItem(txData, 0);
  const items = rlpDecodeListItems(outer.data);
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  const v = new Uint8Array([signature[64]!]);
  const signedItems = [...items, v, r, s];
  const signedData = rlpEncodeList(signedItems);

  return { signedData, signature };
}

/** Decode items from an RLP list payload (for test helper use) */
function rlpDecodeItem(buf: Uint8Array, offset: number): { data: Uint8Array; consumed: number; isList: boolean } {
  const prefix = buf[offset]!;
  if (prefix <= 0x7f) {
    return { data: buf.slice(offset, offset + 1), consumed: 1, isList: false };
  }
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    return { data: buf.slice(offset + 1, offset + 1 + len), consumed: 1 + len, isList: false };
  }
  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7;
    let len = 0;
    for (let i = 0; i < lenOfLen; i++) {
      len = len * 256 + buf[offset + 1 + i]!;
    }
    return { data: buf.slice(offset + 1 + lenOfLen, offset + 1 + lenOfLen + len), consumed: 1 + lenOfLen + len, isList: false };
  }
  if (prefix <= 0xf7) {
    const len = prefix - 0xc0;
    return { data: buf.slice(offset + 1, offset + 1 + len), consumed: 1 + len, isList: true };
  }
  const lenOfLen = prefix - 0xf7;
  let len = 0;
  for (let i = 0; i < lenOfLen; i++) {
    len = len * 256 + buf[offset + 1 + i]!;
  }
  return { data: buf.slice(offset + 1 + lenOfLen, offset + 1 + lenOfLen + len), consumed: 1 + lenOfLen + len, isList: true };
}

/** Decode all items within an RLP list payload */
function rlpDecodeListItems(payload: Uint8Array): Uint8Array[] {
  const items: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const { data, consumed } = rlpDecodeItem(payload, offset);
    items.push(data);
    offset += consumed;
  }
  return items;
}

// Fixed EVM private key for deterministic tests
const EVM_PRIVATE_KEY = secp256k1.utils.randomPrivateKey();
const EVM_ADDRESS = deriveEvmAddress(EVM_PRIVATE_KEY);

// Use a fixed keypair so the address is deterministic and valid
const MOCK_KEYPAIR = Keypair.generate();
const MOCK_ADDRESS = MOCK_KEYPAIR.publicKey.toBase58();

// ── Mock provider factory ───────────────────────────────────────────────────

function createMockProvider(overrides?: Partial<MpcSigningProvider>): MpcSigningProvider {
  return {
    name: "mock-mpc",
    getAddress: vi.fn(async () => MOCK_ADDRESS),
    signTransaction: vi.fn(async (data: Uint8Array) => {
      // For Solana chain: deserialize the unsigned tx, sign it, and return valid data.
      const tx = VersionedTransaction.deserialize(data);
      tx.sign([MOCK_KEYPAIR]);
      return {
        signedData: tx.serialize(),
        signature: tx.signatures[0],
      };
    }),
    healthCheck: vi.fn(async () => true),
    ...overrides,
  };
}

function createSigner(
  providerOverrides?: Partial<MpcSigningProvider>,
  configOverrides?: Partial<MpcSignerConfig>,
): MpcSigner {
  const provider = createMockProvider(providerOverrides);
  return new MpcSigner({
    provider,
    chain: "solana",
    ...configOverrides,
    // Allow provider override via configOverrides too
    ...(configOverrides?.provider ? {} : { provider }),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MpcSigner", () => {
  describe("constructor", () => {
    it("should instantiate with required config", () => {
      const signer = createSigner();
      expect(signer).toBeDefined();
    });

    it("should accept custom maxRetries and timeoutMs", () => {
      const signer = createSigner({}, { maxRetries: 5, timeoutMs: 60_000 });
      expect(signer).toBeDefined();
    });
  });

  describe("getAddress()", () => {
    it("should delegate to provider and return the address", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const address = await signer.getAddress();
      expect(address).toBe(MOCK_ADDRESS);
      expect(provider.getAddress).toHaveBeenCalledOnce();
    });

    it("should cache the address after first call", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const addr1 = await signer.getAddress();
      const addr2 = await signer.getAddress();
      expect(addr1).toBe(addr2);
      expect(provider.getAddress).toHaveBeenCalledOnce();
    });

    it("should retry on transient failure then succeed", async () => {
      const recoveredAddress = validSolanaAddress();
      let attempt = 0;
      const provider = createMockProvider({
        getAddress: vi.fn(async () => {
          if (attempt++ === 0) throw new Error("network blip");
          return recoveredAddress;
        }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 2 });

      const address = await signer.getAddress();
      expect(address).toBe(recoveredAddress);
      expect(provider.getAddress).toHaveBeenCalledTimes(2);
    });

    it("should throw MpcSignerError after exhausting retries", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => { throw new Error("persistent failure"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 1 });

      await expect(signer.getAddress()).rejects.toThrow(MpcSignerError);
      await expect(signer.getAddress()).rejects.toThrow(/failed after 2 attempts/);
    });

    it("HIGH-02: should reject empty address from provider", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => ""),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(signer.getAddress()).rejects.toThrow(MpcSignerError);
      await expect(signer.getAddress()).rejects.toThrow(/invalid address/);
    });

    it("HIGH-02: should reject overly long address from provider", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => "a".repeat(129)),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(signer.getAddress()).rejects.toThrow(MpcSignerError);
      await expect(signer.getAddress()).rejects.toThrow(/invalid address/);
    });

    it("HIGH-02: should reject invalid Solana address format", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => "not-a-valid-solana-pubkey!!!"),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(signer.getAddress()).rejects.toThrow(MpcSignerError);
      await expect(signer.getAddress()).rejects.toThrow(/invalid Solana address/);
    });

    it("HIGH-02: should accept valid non-Solana address without PublicKey validation", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => "0x1234567890abcdef1234567890abcdef12345678"),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const address = await signer.getAddress();
      expect(address).toBe("0x1234567890abcdef1234567890abcdef12345678");
    });
  });

  describe("sign()", () => {
    it("should delegate to provider and return SignedTransaction", async () => {
      const txData = buildValidSolanaTransaction(MOCK_KEYPAIR.publicKey);
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const result = await signer.sign({
        chain: "solana",
        data: txData,
      });

      expect(result.chain).toBe("solana");
      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.signature).toBeInstanceOf(Uint8Array);
      expect(result.signature.length).toBe(64);
      expect(provider.signTransaction).toHaveBeenCalledWith(txData);
    });

    it("should reject chain mismatch without calling provider", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(MpcSignerError);

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(/configured for "solana" but received transaction for "ethereum"/);

      expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it("should set CHAIN_MISMATCH error code on chain mismatch", async () => {
      const signer = createSigner();
      try {
        await signer.sign({ chain: "base", data: new Uint8Array([1]) });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("CHAIN_MISMATCH");
        expect((err as MpcSignerError).provider).toBe("mock-mpc");
      }
    });

    it("should not retry on chain mismatch", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 5 });

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(MpcSignerError);

      // signTransaction should never be called
      expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it("should retry on transient provider failure", async () => {
      const txData = buildValidSolanaTransaction(MOCK_KEYPAIR.publicKey);
      let attempt = 0;
      const provider = createMockProvider({
        signTransaction: vi.fn(async (data: Uint8Array) => {
          if (attempt++ === 0) throw new Error("temporary error");
          const tx = VersionedTransaction.deserialize(data);
          tx.sign([MOCK_KEYPAIR]);
          return { signedData: tx.serialize(), signature: tx.signatures[0] };
        }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 2 });

      const result = await signer.sign({
        chain: "solana",
        data: txData,
      });
      expect(result.chain).toBe("solana");
      expect(provider.signTransaction).toHaveBeenCalledTimes(2);
    });

    it("should throw PROVIDER_ERROR after exhausting retries", async () => {
      const provider = createMockProvider({
        signTransaction: vi.fn(async () => { throw new Error("always fails"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 1 });

      try {
        await signer.sign({ chain: "solana", data: new Uint8Array([1]) });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("PROVIDER_ERROR");
        expect((err as MpcSignerError).message).toContain("failed after 2 attempts");
      }
    });

    it("HIGH-03: should reject unknown chain (fail-closed)", async () => {
      const provider = createMockProvider({
        signTransaction: vi.fn(async (data: Uint8Array) => ({
          signedData: new Uint8Array([...data, 0xff]),
          signature: new Uint8Array(64).fill(0xab),
        })),
      });
      const signer = new MpcSigner({ provider, chain: "polygon" });

      await expect(
        signer.sign({ chain: "polygon", data: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow(/No expected signature length configured/);
    });

    it("HIGH-03: should reject wrong signature length for ethereum", async () => {
      const provider = createMockProvider({
        signTransaction: vi.fn(async (data: Uint8Array) => ({
          signedData: new Uint8Array([...data, 0xff]),
          signature: new Uint8Array(64).fill(0xab), // 64 instead of expected 65
        })),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow(/expected 65 bytes/);
    });

    it("CRIT-01: should reject signed transaction with tampered message bytes", async () => {
      const txData = buildValidSolanaTransaction(MOCK_KEYPAIR.publicKey);
      // A malicious provider that returns a different transaction than what was requested
      const differentKeypair = Keypair.generate();
      const differentTxData = buildValidSolanaTransaction(differentKeypair.publicKey);
      const provider = createMockProvider({
        signTransaction: vi.fn(async () => {
          const differentTx = VersionedTransaction.deserialize(differentTxData);
          differentTx.sign([differentKeypair]);
          return { signedData: differentTx.serialize(), signature: differentTx.signatures[0] };
        }),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(
        signer.sign({ chain: "solana", data: txData }),
      ).rejects.toThrow(/message bytes.*differ/);
    });
  });

  describe("healthCheck()", () => {
    it("should delegate to provider and return true when healthy", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(true);
      expect(provider.healthCheck).toHaveBeenCalledOnce();
    });

    it("should delegate to provider and return false when unhealthy", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(async () => false),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(false);
    });

    it("should return false when provider throws (no retry)", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(async () => { throw new Error("unreachable"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(false);
      // Should only be called once — no retry for health checks
      expect(provider.healthCheck).toHaveBeenCalledOnce();
    });
  });

  describe("timeout", () => {
    it("should throw TIMEOUT error when provider is too slow", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(MOCK_ADDRESS), 500))),
      });
      const signer = new MpcSigner({ provider, chain: "solana", timeoutMs: 50 });

      try {
        await signer.getAddress();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("TIMEOUT");
        expect((err as MpcSignerError).message).toContain("timed out after 50ms");
      }
    });

    it("should return false from healthCheck on timeout", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(true), 500))),
      });
      const signer = new MpcSigner({ provider, chain: "solana", timeoutMs: 50 });

      expect(await signer.healthCheck()).toBe(false);
    });
  });

  describe("destroy()", () => {
    it("should prevent signing after destroy", async () => {
      const signer = createSigner();
      await signer.destroy();

      await expect(
        signer.sign({ chain: "solana", data: new Uint8Array([1]) }),
      ).rejects.toThrow(/destroyed/);
    });

    it("LOW-03: should call provider destroy if available", async () => {
      const providerDestroy = vi.fn(async () => {});
      const provider = createMockProvider({ destroy: providerDestroy });
      const signer = new MpcSigner({ provider, chain: "solana" });

      await signer.destroy();
      expect(providerDestroy).toHaveBeenCalledOnce();
    });

    it("LOW-03: should not fail if provider destroy throws", async () => {
      const provider = createMockProvider({
        destroy: vi.fn(async () => { throw new Error("cleanup failed"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      // Should not throw
      await expect(signer.destroy()).resolves.toBeUndefined();
    });

    it("LOW-03: should succeed if provider has no destroy method", async () => {
      const provider = createMockProvider();
      // provider has no destroy method by default
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(signer.destroy()).resolves.toBeUndefined();
    });

    it("MED-02: should reset addressCachedAt on destroy", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      // Populate cache
      await signer.getAddress();

      await signer.destroy();

      // After destroy, signing should fail
      await expect(
        signer.sign({ chain: "solana", data: new Uint8Array([1]) }),
      ).rejects.toThrow(/destroyed/);
    });
  });

  describe("toJSON()", () => {
    it("LOW-02: should return safe representation", () => {
      const signer = createSigner();
      const json = signer.toJSON();
      expect(json).toHaveProperty("provider", "mock-mpc");
      expect(json).toHaveProperty("chain", "solana");
      expect(json).toHaveProperty("destroyed", false);
    });
  });

  describe("MpcSignerError", () => {
    it("should carry code, provider, and message", () => {
      const err = new MpcSignerError("PROVIDER_ERROR", "turnkey", "something broke");
      expect(err.code).toBe("PROVIDER_ERROR");
      expect(err.provider).toBe("turnkey");
      expect(err.message).toBe("something broke");
      expect(err.name).toBe("MpcSignerError");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("different provider configs", () => {
    it("should work with any provider name", async () => {
      for (const name of ["turnkey", "lit-protocol", "fireblocks", "custom-hsm"]) {
        const provider = createMockProvider({ name });
        const signer = new MpcSigner({ provider, chain: "solana" });
        const address = await signer.getAddress();
        expect(address).toBe(MOCK_ADDRESS);
      }
    });

    it("should work with ethereum chain", async () => {
      const txData = buildValidEvmTransaction();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS),
        signTransaction: vi.fn(async (data: Uint8Array) => signEvmData(EVM_PRIVATE_KEY, data)),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const result = await signer.sign({
        chain: "ethereum",
        data: txData,
      });
      expect(result.chain).toBe("ethereum");
      expect(result.signature.length).toBe(65);
    });
  });

  describe("M-41: EVM signature verification (ecrecover)", () => {
    it("should accept valid EVM signature that recovers to expected address", async () => {
      const txData = buildValidEvmTransaction();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS),
        signTransaction: vi.fn(async (data: Uint8Array) => signEvmData(EVM_PRIVATE_KEY, data)),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const result = await signer.sign({ chain: "ethereum", data: txData });
      expect(result.chain).toBe("ethereum");
    });

    it("should reject EVM signature from wrong signer", async () => {
      const wrongKey = secp256k1.utils.randomPrivateKey();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS), // expects EVM_ADDRESS
        signTransaction: vi.fn(async (data: Uint8Array) => signEvmData(wrongKey, data)), // signs with different key
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      await expect(
        signer.sign({ chain: "ethereum", data: buildValidEvmTransaction() }),
      ).rejects.toThrow(/CRYPTO-002.*recovers to.*different address/);
    });

    it("should reject invalid recovery parameter v", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS),
        signTransaction: vi.fn(async (data: Uint8Array) => {
          const { signature, signedData } = signEvmData(EVM_PRIVATE_KEY, data);
          signature[64] = 5; // invalid v value
          return { signedData, signature };
        }),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      await expect(
        signer.sign({ chain: "ethereum", data: buildValidEvmTransaction() }),
      ).rejects.toThrow(/CRYPTO-002.*Invalid EVM signature recovery parameter/);
    });

    it("should work with v=0/1 (modern format)", async () => {
      const txData = buildValidEvmTransaction();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS),
        signTransaction: vi.fn(async (data: Uint8Array) => {
          const result = signEvmData(EVM_PRIVATE_KEY, data);
          // Convert v from 27/28 to 0/1
          result.signature[64] = result.signature[64]! - 27;
          return result;
        }),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const result = await signer.sign({ chain: "ethereum", data: txData });
      expect(result.chain).toBe("ethereum");
    });

    it("should work with base chain", async () => {
      const txData = buildValidEvmTransaction();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => EVM_ADDRESS),
        signTransaction: vi.fn(async (data: Uint8Array) => signEvmData(EVM_PRIVATE_KEY, data)),
      });
      const signer = new MpcSigner({ provider, chain: "base" });

      const result = await signer.sign({ chain: "base", data: txData });
      expect(result.chain).toBe("base");
    });

    it("should handle case-insensitive address comparison", async () => {
      const txData = buildValidEvmTransaction();
      // Return EIP-55 mixed-case address (0x prefix stays lowercase, hex digits uppercase)
      const checksumAddress = "0x" + EVM_ADDRESS.slice(2).toUpperCase();
      const provider = createMockProvider({
        getAddress: vi.fn(async () => checksumAddress),
        signTransaction: vi.fn(async (data: Uint8Array) => signEvmData(EVM_PRIVATE_KEY, data)),
      });
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const result = await signer.sign({ chain: "ethereum", data: txData });
      expect(result.chain).toBe("ethereum");
    });
  });
});
