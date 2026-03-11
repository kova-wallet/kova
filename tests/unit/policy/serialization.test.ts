import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  serializePolicy,
  deserializePolicy,
  Policy,
} from "../../../src/policy/serialization.js";
import type {
  VersionedPolicyConfig,
  SignedVersionedPolicyConfig,
} from "../../../src/policy/serialization.js";

/** Helper: build a minimal valid policy */
function buildPolicy(name = "test-policy") {
  return Policy.create(name)
    .rateLimit({ maxTransactionsPerMinute: 10 })
    .build();
}

describe("Policy Serialization", () => {
  // ─── serializePolicy ──────────────────────────────────────────────

  describe("serializePolicy()", () => {
    it("should serialize with HMAC when hmacKey is provided", () => {
      const policy = buildPolicy();
      const key = "test-hmac-key";
      const result = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      expect(result).toHaveProperty("payload");
      expect(result).toHaveProperty("hmac");
      expect(typeof result.payload).toBe("string");
      expect(typeof result.hmac).toBe("string");

      // Verify the HMAC matches re-computation
      const expectedHmac = createHmac("sha256", key)
        .update(result.payload)
        .digest("hex");
      expect(result.hmac).toBe(expectedHmac);

      // Payload should parse to a versioned config
      const parsed = JSON.parse(result.payload) as VersionedPolicyConfig;
      expect(parsed.version).toBe(1);
      expect(parsed.policy.name).toBe("test-policy");
    });

    it("should serialize without HMAC and emit warning when no hmacKey", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const policy = buildPolicy();
      const result = serializePolicy(policy) as VersionedPolicyConfig;

      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("policy");
      expect(result.version).toBe(1);
      expect(result.policy.name).toBe("test-policy");
      expect(result).not.toHaveProperty("hmac");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("serializePolicy() called without hmacKey"),
        expect.objectContaining({ code: "KOVA_POLICY_NO_HMAC" }),
      );

      warnSpy.mockRestore();
    });

    it("should accept Buffer as hmacKey", () => {
      const policy = buildPolicy();
      const key = Buffer.from("secret-buffer-key");
      const result = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      expect(result).toHaveProperty("payload");
      expect(result).toHaveProperty("hmac");
    });
  });

  // ─── deserializePolicy — HMAC verification ────────────────────────

  describe("deserializePolicy() HMAC verification", () => {
    it("should accept a valid HMAC-signed payload", () => {
      const policy = buildPolicy();
      const key = "test-key";
      const serialized = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      const restored = deserializePolicy(serialized, key);
      expect(restored.getName()).toBe("test-policy");
    });

    it("should throw on tampered HMAC", () => {
      const policy = buildPolicy();
      const key = "test-key";
      const serialized = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      serialized.hmac = "deadbeef".repeat(8); // 64 hex chars = 32 bytes

      expect(() => deserializePolicy(serialized, key)).toThrow(
        "Policy HMAC verification failed",
      );
    });

    it("should throw on tampered payload", () => {
      const policy = buildPolicy();
      const key = "test-key";
      const serialized = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      // Modify the payload after signing
      const parsed = JSON.parse(serialized.payload);
      parsed.policy.name = "hacked-policy";
      serialized.payload = JSON.stringify(parsed);

      expect(() => deserializePolicy(serialized, key)).toThrow(
        "Policy HMAC verification failed",
      );
    });

    it("should throw when HMAC is present but no hmacKey provided", () => {
      const policy = buildPolicy();
      const key = "test-key";
      const serialized = serializePolicy(policy, key) as SignedVersionedPolicyConfig;

      expect(() => deserializePolicy(serialized)).toThrow(
        "Serialized policy has an HMAC signature but no hmacKey was provided",
      );
    });

    it("should emit warning when deserializing unsigned policy without hmacKey", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      deserializePolicy(data);

      // Should include both the serialize warning (none here since we pass raw) and deserialize warning
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deserializePolicy() called without hmacKey"),
        expect.objectContaining({ code: "KOVA_POLICY_NO_HMAC" }),
      );

      warnSpy.mockRestore();
    });
  });

  // ─── Size limit ────────────────────────────────────────────────────

  describe("size limit", () => {
    it("should throw when payload exceeds MAX_SERIALIZED_SIZE (1 MB)", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      // Create a payload that exceeds 1 MB via a large array of addresses
      const hugeAddresses = Array.from({ length: 50_000 }, (_, i) =>
        `addr_${"x".repeat(20)}_${i}`,
      );

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "huge-policy",
          allowAddresses: hugeAddresses,
        },
      };

      expect(() => deserializePolicy(data)).toThrow(/exceeds maximum/);

      warnSpy.mockRestore();
    });
  });

  // ─── Nesting depth ─────────────────────────────────────────────────

  describe("nesting depth", () => {
    it("should throw when object nesting exceeds 20 levels", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      // Build a deeply nested object
      let nested: Record<string, unknown> = { value: "deep" };
      for (let i = 0; i < 25; i++) {
        nested = { child: nested };
      }

      const data = {
        version: 1,
        policy: {
          name: "deep-policy",
          rateLimit: { maxTransactionsPerMinute: 5 },
          // Smuggle deeply nested data through an extra key
          ...({ deepData: nested } as Record<string, unknown>),
        },
      } as unknown as VersionedPolicyConfig;

      expect(() => deserializePolicy(data)).toThrow(
        /nesting depth exceeds maximum of 20/,
      );

      warnSpy.mockRestore();
    });

    it("should accept objects within the nesting limit", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "shallow-policy",
          rateLimit: { maxTransactionsPerMinute: 5 },
        },
      };

      const policy = deserializePolicy(data);
      expect(policy.getName()).toBe("shallow-policy");

      warnSpy.mockRestore();
    });
  });

  // ─── Version validation ────────────────────────────────────────────

  describe("version validation", () => {
    it("should throw on missing version field", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data = { policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } } };

      expect(() => deserializePolicy(data as unknown as VersionedPolicyConfig)).toThrow(
        /missing or non-numeric 'version' field/,
      );
      warnSpy.mockRestore();
    });

    it("should throw on NaN version", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data = {
        version: NaN,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      // NaN becomes null after JSON.stringify deep-clone, so it hits the type check first
      expect(() => deserializePolicy(data as VersionedPolicyConfig)).toThrow(
        /missing or non-numeric 'version' field/,
      );
      warnSpy.mockRestore();
    });

    it("should throw on negative version", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data: VersionedPolicyConfig = {
        version: -1,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      expect(() => deserializePolicy(data)).toThrow("Invalid policy version");
      warnSpy.mockRestore();
    });

    it("should throw on zero version", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data: VersionedPolicyConfig = {
        version: 0,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      expect(() => deserializePolicy(data)).toThrow("Invalid policy version");
      warnSpy.mockRestore();
    });

    it("should throw on Infinity version", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data = {
        version: Infinity,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      // Infinity becomes null after JSON.stringify deep-clone, so it hits the type check first
      expect(() => deserializePolicy(data as VersionedPolicyConfig)).toThrow(
        /missing or non-numeric 'version' field/,
      );
      warnSpy.mockRestore();
    });

    it("should throw on unsupported version (e.g., 99)", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const data: VersionedPolicyConfig = {
        version: 99,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
      };

      expect(() => deserializePolicy(data)).toThrow(
        /Unsupported policy schema version: 99/,
      );
      warnSpy.mockRestore();
    });
  });

  // ─── Unknown key warnings ─────────────────────────────────────────

  describe("unknown key warnings", () => {
    it("should warn on unknown keys in the versioned envelope", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data = {
        version: 1,
        policy: { name: "test", rateLimit: { maxTransactionsPerMinute: 5 } },
        unknownEnvelopeField: "surprise",
      } as unknown as VersionedPolicyConfig;

      deserializePolicy(data);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized field "unknownEnvelopeField"'),
        expect.objectContaining({ code: "KOVA_POLICY_UNKNOWN_FIELD" }),
      );

      warnSpy.mockRestore();
    });

    it("should warn on unknown keys in the policy config", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "test",
          rateLimit: { maxTransactionsPerMinute: 5 },
          ...({ futureFeature: true } as Record<string, unknown>),
        },
      };

      deserializePolicy(data);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized field "futureFeature"'),
        expect.objectContaining({ code: "KOVA_POLICY_UNKNOWN_FIELD" }),
      );

      warnSpy.mockRestore();
    });
  });

  // ─── validatePolicyConsistency ─────────────────────────────────────

  describe("validatePolicyConsistency", () => {
    it("should warn when spending limit token is in denyPrograms", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "conflict-policy",
          spendingLimit: {
            daily: { amount: "100", token: "SOL" },
          },
          denyPrograms: ["SOL"],
          allowAddresses: ["addr1"], // positive rule to avoid deny-only warning
        },
      };

      deserializePolicy(data);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("spending limit configured for token"),
        expect.objectContaining({ code: "KOVA_POLICY_CONSISTENCY_WARNING" }),
      );

      warnSpy.mockRestore();
    });

    it("should warn on overlapping time windows", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "overlap-policy",
          activeHours: {
            timezone: "UTC",
            windows: [
              { days: ["mon", "tue"], start: "09:00", end: "17:00" },
              { days: ["tue", "wed"], start: "12:00", end: "20:00" },
            ],
          },
        },
      };

      deserializePolicy(data);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("overlap"),
        expect.objectContaining({ code: "KOVA_POLICY_CONSISTENCY_WARNING" }),
      );

      warnSpy.mockRestore();
    });

    it("should warn on approval gate token mismatch with spending limit tokens", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const data: VersionedPolicyConfig = {
        version: 1,
        policy: {
          name: "mismatch-policy",
          spendingLimit: {
            daily: { amount: "100", token: "SOL" },
          },
          approvalGate: {
            above: { amount: "50", token: "USDC" },
          },
        },
      };

      deserializePolicy(data);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("approval gate is configured for token"),
        expect.objectContaining({ code: "KOVA_POLICY_CONSISTENCY_WARNING" }),
      );

      warnSpy.mockRestore();
    });
  });

  // ─── Round-trip ────────────────────────────────────────────────────

  describe("round-trip", () => {
    it("should produce an equivalent policy after serialize → deserialize (unsigned)", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const original = Policy.create("round-trip-test")
        .spendingLimit({
          perTransaction: { amount: "5", token: "SOL" },
          daily: { amount: "50", token: "SOL" },
        })
        .allowAddresses(["addr1", "addr2"])
        .denyAddresses(["bad-addr"])
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .activeHours({
          timezone: "UTC",
          windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
        })
        .build();

      const serialized = serializePolicy(original) as VersionedPolicyConfig;
      const restored = deserializePolicy(serialized);

      expect(restored.getName()).toBe(original.getName());
      expect(restored.getConfig()).toEqual(original.getConfig());

      warnSpy.mockRestore();
    });

    it("should produce an equivalent policy after serialize → deserialize (HMAC-signed)", () => {
      const key = "round-trip-key";
      const original = Policy.create("signed-round-trip")
        .spendingLimit({
          perTransaction: { amount: "1", token: "USDC" },
        })
        .allowAddresses(["recipient1"])
        .build();

      const serialized = serializePolicy(original, key);
      const restored = deserializePolicy(serialized, key);

      expect(restored.getName()).toBe(original.getName());
      expect(restored.getConfig()).toEqual(original.getConfig());
    });
  });

  // ─── Prototype pollution defense ───────────────────────────────────

  describe("Policy.fromJSON() prototype pollution defense", () => {
    it("should strip __proto__ keys from deserialized policy", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      // Use JSON.parse to create an object with an own __proto__ property
      const maliciousConfig = JSON.parse(
        '{"name":"evil","rateLimit":{"maxTransactionsPerMinute":5},"__proto__":{"polluted":true}}',
      );

      const policy = Policy.fromJSON(maliciousConfig);
      const config = policy.getConfig() as Record<string, unknown>;

      expect(config).not.toHaveProperty("__proto__");
      // Ensure Object.prototype was not polluted
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("should strip constructor keys from deserialized policy", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const maliciousConfig = JSON.parse(
        '{"name":"evil","rateLimit":{"maxTransactionsPerMinute":5},"constructor":{"prototype":{"polluted":true}}}',
      );

      const policy = Policy.fromJSON(maliciousConfig);
      const config = policy.getConfig() as Record<string, unknown>;

      expect(config).not.toHaveProperty("constructor");

      warnSpy.mockRestore();
    });

    it("should strip prototype keys from deserialized policy", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const maliciousConfig = JSON.parse(
        '{"name":"evil","rateLimit":{"maxTransactionsPerMinute":5},"prototype":{"polluted":true}}',
      );

      const policy = Policy.fromJSON(maliciousConfig);
      const config = policy.getConfig() as Record<string, unknown>;

      expect(config).not.toHaveProperty("prototype");

      warnSpy.mockRestore();
    });

    it("should strip dangerous keys recursively in nested objects", () => {
      const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

      const maliciousConfig = JSON.parse(
        '{"name":"evil","rateLimit":{"maxTransactionsPerMinute":5,"__proto__":{"polluted":true}}}',
      );

      const policy = Policy.fromJSON(maliciousConfig);
      const config = policy.getConfig();
      const rateLimit = config.rateLimit as unknown as Record<string, unknown>;

      expect(rateLimit).not.toHaveProperty("__proto__");
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

      warnSpy.mockRestore();
    });
  });
});
