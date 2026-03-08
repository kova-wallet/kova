import { describe, it, expect, beforeEach } from "vitest";
import {
  createApiKey,
  validateApiKey,
  isKeyAuthorizedForWallet,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
} from "@/lib/api-keys";

// Clear key store between tests
const KEYS_GLOBAL_KEY = "__kova_api_keys__";

function clearKeyStore() {
  delete (globalThis as Record<string, unknown>)[KEYS_GLOBAL_KEY];
}

describe("API Keys", () => {
  beforeEach(() => {
    clearKeyStore();
  });

  describe("createApiKey", () => {
    it("creates a key with kova_ prefix", () => {
      const { key, id } = createApiKey("test-agent", "*");
      expect(key).toMatch(/^kova_[a-f0-9]{48}$/);
      expect(id).toMatch(/^key_[a-f0-9]{16}$/);
    });

    it("creates unique keys each time", () => {
      const key1 = createApiKey("agent-1", "*");
      const key2 = createApiKey("agent-2", "*");
      expect(key1.key).not.toBe(key2.key);
      expect(key1.id).not.toBe(key2.id);
    });
  });

  describe("validateApiKey", () => {
    it("validates a correct key", () => {
      const { key } = createApiKey("test-agent", "*");
      const result = validateApiKey(key);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("test-agent");
      expect(result!.active).toBe(true);
    });

    it("rejects an invalid key", () => {
      expect(validateApiKey("kova_invalid")).toBeNull();
    });

    it("rejects empty string", () => {
      expect(validateApiKey("")).toBeNull();
    });

    it("rejects non-kova prefix", () => {
      expect(validateApiKey("Bearer abc123")).toBeNull();
    });

    it("updates lastUsedAt on validation", () => {
      const { key, id } = createApiKey("test-agent", "*");
      const before = listApiKeys().find((k) => k.id === id);
      expect(before!.lastUsedAt).toBeNull();

      validateApiKey(key);

      const after = listApiKeys().find((k) => k.id === id);
      expect(after!.lastUsedAt).toBeGreaterThan(0);
    });

    it("rejects revoked key", () => {
      const { key, id } = createApiKey("test-agent", "*");
      revokeApiKey(id);
      expect(validateApiKey(key)).toBeNull();
    });
  });

  describe("isKeyAuthorizedForWallet", () => {
    it("wildcard key is authorized for any wallet", () => {
      const { key } = createApiKey("agent", "*");
      const validated = validateApiKey(key)!;
      expect(isKeyAuthorizedForWallet(validated, "any-address")).toBe(true);
    });

    it("scoped key is authorized for matching wallet", () => {
      const { key } = createApiKey("agent", "wallet-abc");
      const validated = validateApiKey(key)!;
      expect(isKeyAuthorizedForWallet(validated, "wallet-abc")).toBe(true);
    });

    it("scoped key is not authorized for different wallet", () => {
      const { key } = createApiKey("agent", "wallet-abc");
      const validated = validateApiKey(key)!;
      expect(isKeyAuthorizedForWallet(validated, "wallet-xyz")).toBe(false);
    });
  });

  describe("listApiKeys", () => {
    it("returns empty list initially", () => {
      expect(listApiKeys()).toEqual([]);
    });

    it("lists created keys without hashes", () => {
      createApiKey("agent-1", "*");
      createApiKey("agent-2", "addr");

      const keys = listApiKeys();
      expect(keys).toHaveLength(2);
      expect(keys[0].label).toBe("agent-1");
      expect(keys[1].label).toBe("agent-2");
      // Should not include hash
      for (const k of keys) {
        expect((k as Record<string, unknown>).hash).toBeUndefined();
      }
    });
  });

  describe("revokeApiKey", () => {
    it("revokes an existing key", () => {
      const { id } = createApiKey("agent", "*");
      expect(revokeApiKey(id)).toBe(true);
      expect(listApiKeys().find((k) => k.id === id)!.active).toBe(false);
    });

    it("returns false for non-existent key", () => {
      expect(revokeApiKey("key_nonexistent")).toBe(false);
    });
  });

  describe("deleteApiKey", () => {
    it("deletes an existing key", () => {
      const { id } = createApiKey("agent", "*");
      expect(deleteApiKey(id)).toBe(true);
      expect(listApiKeys()).toHaveLength(0);
    });

    it("returns false for non-existent key", () => {
      expect(deleteApiKey("key_nonexistent")).toBe(false);
    });
  });
});
