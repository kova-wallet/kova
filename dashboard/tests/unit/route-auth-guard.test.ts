import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireDashboardAuth, createAuthToken } from "@/lib/auth";

describe("requireDashboardAuth (defense-in-depth)", () => {
  const originalPassword = process.env.KOVA_DASHBOARD_PASSWORD;

  afterEach(() => {
    if (originalPassword !== undefined) {
      process.env.KOVA_DASHBOARD_PASSWORD = originalPassword;
    } else {
      delete process.env.KOVA_DASHBOARD_PASSWORD;
    }
  });

  it("allows all requests when no password is configured", () => {
    delete process.env.KOVA_DASHBOARD_PASSWORD;
    const req = new Request("http://localhost/api/policy");
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(true);
  });

  it("rejects requests with no cookie when password is set", async () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "test-password";
    const req = new Request("http://localhost/api/policy");
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error).toBe("Authentication required");
    }
  });

  it("rejects requests with invalid cookie when password is set", async () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "test-password";
    const req = new Request("http://localhost/api/policy", {
      headers: { cookie: "kova_auth=invalid-token" },
    });
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(false);
  });

  it("accepts requests with valid signed cookie", () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "test-password";
    const token = createAuthToken();
    const req = new Request("http://localhost/api/policy", {
      headers: { cookie: `kova_auth=${token}` },
    });
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(true);
  });

  it("accepts valid cookie among multiple cookies", () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "test-password";
    const token = createAuthToken();
    const req = new Request("http://localhost/api/policy", {
      headers: { cookie: `other=value; kova_auth=${token}; another=thing` },
    });
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(true);
  });

  it("rejects API key bearer token (not a session cookie)", async () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "test-password";
    // An agent trying to use an API key on a non-execute endpoint
    const req = new Request("http://localhost/api/policy", {
      headers: { authorization: "Bearer kova_abc123" },
    });
    const result = requireDashboardAuth(req);
    expect(result.authenticated).toBe(false);
  });
});
