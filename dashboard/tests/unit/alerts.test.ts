import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireAlert,
  getRecentAlerts,
  clearAlerts,
  alertTransactionDenied,
  alertCircuitBreakerTripped,
  alertSpendingLimitWarning,
} from "@/lib/alerts";
import type { AlertEvent } from "@/lib/alerts";

// Suppress console.log in tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

describe("Alert System", () => {
  beforeEach(() => {
    clearAlerts();
    delete process.env.KOVA_ALERT_WEBHOOKS;
  });

  it("stores alerts in memory", async () => {
    await fireAlert({
      type: "test",
      level: "info",
      message: "Test alert",
      walletAddress: "addr1",
      timestamp: Date.now(),
    });

    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("test");
    expect(alerts[0].message).toBe("Test alert");
  });

  it("returns most recent alerts first", async () => {
    await fireAlert({
      type: "first",
      level: "info",
      message: "First",
      walletAddress: "addr1",
      timestamp: 1000,
    });
    await fireAlert({
      type: "second",
      level: "info",
      message: "Second",
      walletAddress: "addr1",
      timestamp: 2000,
    });

    const alerts = getRecentAlerts();
    expect(alerts[0].type).toBe("second");
    expect(alerts[1].type).toBe("first");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await fireAlert({
        type: `alert-${i}`,
        level: "info",
        message: `Alert ${i}`,
        walletAddress: "addr1",
        timestamp: Date.now(),
      });
    }

    expect(getRecentAlerts(3)).toHaveLength(3);
    expect(getRecentAlerts(100)).toHaveLength(10);
  });

  it("clears all alerts", async () => {
    await fireAlert({
      type: "test",
      level: "info",
      message: "Test",
      walletAddress: "addr1",
      timestamp: Date.now(),
    });

    clearAlerts();
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("caps history at 200 entries", async () => {
    for (let i = 0; i < 210; i++) {
      await fireAlert({
        type: `alert-${i}`,
        level: "info",
        message: `Alert ${i}`,
        walletAddress: "addr1",
        timestamp: Date.now(),
      });
    }

    expect(getRecentAlerts(500)).toHaveLength(200);
  });

  describe("convenience creators", () => {
    it("alertTransactionDenied creates warning alert", async () => {
      await alertTransactionDenied("addr1", "spending limit exceeded", "intent-1");
      const alerts = getRecentAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe("transaction_denied");
      expect(alerts[0].level).toBe("warning");
      expect(alerts[0].details).toEqual({ intentId: "intent-1", reason: "spending limit exceeded" });
    });

    it("alertCircuitBreakerTripped creates critical alert", async () => {
      await alertCircuitBreakerTripped("addr1", "too many failures");
      const alerts = getRecentAlerts();
      expect(alerts[0].type).toBe("circuit_breaker_tripped");
      expect(alerts[0].level).toBe("critical");
    });

    it("alertSpendingLimitWarning creates warning alert", async () => {
      await alertSpendingLimitWarning("addr1", "SOL", "8", "10", "daily");
      const alerts = getRecentAlerts();
      expect(alerts[0].type).toBe("spending_limit_warning");
      expect(alerts[0].details).toEqual({
        token: "SOL",
        spent: "8",
        limit: "10",
        window: "daily",
      });
    });
  });

  describe("webhook dispatch", () => {
    it("dispatches to configured webhook URLs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      process.env.KOVA_ALERT_WEBHOOKS = "https://hook1.example.com,https://hook2.example.com";

      await fireAlert({
        type: "test",
        level: "info",
        message: "Webhook test",
        walletAddress: "addr1",
        timestamp: Date.now(),
      });

      // Wait for fire-and-forget promises
      await new Promise((r) => setTimeout(r, 10));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://hook1.example.com",
        expect.objectContaining({ method: "POST" })
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "https://hook2.example.com",
        expect.objectContaining({ method: "POST" })
      );

      vi.unstubAllGlobals();
    });

    it("does not dispatch when no webhooks configured", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      await fireAlert({
        type: "test",
        level: "info",
        message: "No webhook",
        walletAddress: "addr1",
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });
});
