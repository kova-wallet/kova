import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAuthEnabled,
  validatePassword,
  createAuthToken,
  verifyAuthToken,
} from "@/lib/auth";

describe("Auth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KOVA_DASHBOARD_PASSWORD;
    delete process.env.KOVA_SESSION_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isAuthEnabled", () => {
    it("returns false when no password is set", () => {
      expect(isAuthEnabled()).toBe(false);
    });

    it("returns true when password is set", () => {
      process.env.KOVA_DASHBOARD_PASSWORD = "test123";
      expect(isAuthEnabled()).toBe(true);
    });

    it("returns false for empty string password", () => {
      process.env.KOVA_DASHBOARD_PASSWORD = "";
      expect(isAuthEnabled()).toBe(false);
    });
  });

  describe("validatePassword", () => {
    it("returns true when no password is configured", () => {
      expect(validatePassword("anything")).toBe(true);
    });

    it("returns true for correct password", () => {
      process.env.KOVA_DASHBOARD_PASSWORD = "secret123";
      expect(validatePassword("secret123")).toBe(true);
    });

    it("returns false for incorrect password", () => {
      process.env.KOVA_DASHBOARD_PASSWORD = "secret123";
      expect(validatePassword("wrong")).toBe(false);
    });

    it("returns false for empty password when one is required", () => {
      process.env.KOVA_DASHBOARD_PASSWORD = "secret123";
      expect(validatePassword("")).toBe(false);
    });
  });

  describe("createAuthToken / verifyAuthToken", () => {
    it("creates a token that can be verified", () => {
      process.env.KOVA_SESSION_SECRET = "test-secret";
      const token = createAuthToken();
      expect(verifyAuthToken(token)).toBe(true);
    });

    it("rejects a tampered token", () => {
      process.env.KOVA_SESSION_SECRET = "test-secret";
      const token = createAuthToken();
      const tampered = token.slice(0, -5) + "xxxxx";
      expect(verifyAuthToken(tampered)).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(verifyAuthToken("")).toBe(false);
    });

    it("rejects a token without a signature", () => {
      expect(verifyAuthToken("no-dot-here")).toBe(false);
    });

    it("rejects a token signed with a different secret", () => {
      process.env.KOVA_SESSION_SECRET = "secret-1";
      const token = createAuthToken();

      process.env.KOVA_SESSION_SECRET = "secret-2";
      expect(verifyAuthToken(token)).toBe(false);
    });

    it("uses default secret when none configured", () => {
      // Both create and verify should use the same default
      const token = createAuthToken();
      expect(verifyAuthToken(token)).toBe(true);
    });
  });
});
