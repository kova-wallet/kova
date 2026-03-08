/**
 * Simple password-based auth for the Kova Dashboard.
 *
 * When KOVA_DASHBOARD_PASSWORD is set, all routes require authentication.
 * Auth state is tracked via a signed cookie.
 *
 * This is intentionally simple — Phase 2 will add OAuth/SSO.
 */

import { createHmac } from "node:crypto";

const AUTH_COOKIE_NAME = "kova_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Check if auth is enabled (password is configured).
 */
export function isAuthEnabled(): boolean {
  return !!process.env.KOVA_DASHBOARD_PASSWORD;
}

/**
 * Validate a password against the configured password.
 */
export function validatePassword(password: string): boolean {
  const expected = process.env.KOVA_DASHBOARD_PASSWORD;
  if (!expected) return true; // No password configured = always valid
  return password === expected;
}

/**
 * Create a signed auth token.
 */
export function createAuthToken(): string {
  const secret = process.env.KOVA_SESSION_SECRET || "kova-dev-secret-change-me";
  const payload = `authenticated:${Date.now()}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Verify a signed auth token.
 */
export function verifyAuthToken(token: string): boolean {
  const secret = process.env.KOVA_SESSION_SECRET || "kova-dev-secret-change-me";
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return false;

  const payload = token.substring(0, lastDot);
  const sig = token.substring(lastDot + 1);

  const expectedSig = createHmac("sha256", secret).update(payload).digest("hex");

  // Constant-time comparison
  if (sig.length !== expectedSig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return mismatch === 0;
}

export { AUTH_COOKIE_NAME, COOKIE_MAX_AGE };
