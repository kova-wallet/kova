import { describe, it, expect, vi, beforeEach } from "vitest";
import { DashboardApprovalChannel } from "@/lib/approval-channel";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: `req-${Date.now()}-${Math.random()}`,
    summary: "Send 1 SOL",
    amount: "1",
    token: "SOL",
    target: "recipient-address",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("DashboardApprovalChannel", () => {
  let channel: DashboardApprovalChannel;

  beforeEach(() => {
    channel = new DashboardApprovalChannel();
  });

  it("has name 'dashboard'", () => {
    expect(channel.name).toBe("dashboard");
  });

  it("returns empty pending list initially", () => {
    expect(channel.getPendingApprovals()).toEqual([]);
  });

  it("stores pending approval when requestApproval is called", () => {
    const request = makeRequest();
    // Don't await — it blocks until resolved
    channel.requestApproval(request);
    const pending = channel.getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(request.id);
  });

  it("resolves with approved when respondToApproval is called", async () => {
    const request = makeRequest();
    const promise = channel.requestApproval(request);

    const success = channel.respondToApproval(request.id, "approved");
    expect(success).toBe(true);

    const result = await promise;
    expect(result.decision).toBe("approved");
    expect(result.requestId).toBe(request.id);
    expect(result.decidedBy).toBe("dashboard-user");
    expect(result.decidedAt).toBeGreaterThan(0);
  });

  it("resolves with rejected when respondToApproval is called", async () => {
    const request = makeRequest();
    const promise = channel.requestApproval(request);

    channel.respondToApproval(request.id, "rejected");

    const result = await promise;
    expect(result.decision).toBe("rejected");
  });

  it("returns false for unknown request id", () => {
    expect(channel.respondToApproval("nonexistent", "approved")).toBe(false);
  });

  it("removes pending approval after response", async () => {
    const request = makeRequest();
    const promise = channel.requestApproval(request);
    channel.respondToApproval(request.id, "approved");
    await promise;

    expect(channel.getPendingApprovals()).toHaveLength(0);
  });

  it("notifies listeners when a new approval is requested", () => {
    const listener = vi.fn();
    channel.addListener(listener);

    const request = makeRequest();
    channel.requestApproval(request);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(request);
  });

  it("removes listener correctly", () => {
    const listener = vi.fn();
    channel.addListener(listener);
    channel.removeListener(listener);

    channel.requestApproval(makeRequest());
    expect(listener).not.toHaveBeenCalled();
  });

  it("handles multiple listeners", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    channel.addListener(listener1);
    channel.addListener(listener2);

    channel.requestApproval(makeRequest());

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("handles listener that throws without breaking other listeners", () => {
    const badListener = vi.fn(() => { throw new Error("oops"); });
    const goodListener = vi.fn();
    channel.addListener(badListener);
    channel.addListener(goodListener);

    channel.requestApproval(makeRequest());

    expect(badListener).toHaveBeenCalledOnce();
    expect(goodListener).toHaveBeenCalledOnce();
  });

  it("times out and resolves with timeout decision", async () => {
    vi.useFakeTimers();
    const request = makeRequest({ expiresAt: Date.now() + 5_000 });
    const promise = channel.requestApproval(request);

    vi.advanceTimersByTime(5_100);

    const result = await promise;
    expect(result.decision).toBe("timeout");
    expect(result.requestId).toBe(request.id);

    // Should be removed from pending
    expect(channel.getPendingApprovals()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("preserves intentHash in response", async () => {
    const request = makeRequest({ intentHash: "abc123" });
    const promise = channel.requestApproval(request);

    channel.respondToApproval(request.id, "approved");
    const result = await promise;
    expect(result.intentHash).toBe("abc123");
  });

  it("allows custom decidedBy in respondToApproval", async () => {
    const request = makeRequest();
    const promise = channel.requestApproval(request);

    channel.respondToApproval(request.id, "approved", "admin@example.com");
    const result = await promise;
    expect(result.decidedBy).toBe("admin@example.com");
  });

  describe("destroy", () => {
    it("resolves all pending approvals with timeout", async () => {
      const req1 = makeRequest({ id: "req-1" });
      const req2 = makeRequest({ id: "req-2" });
      const promise1 = channel.requestApproval(req1);
      const promise2 = channel.requestApproval(req2);

      channel.destroy();

      const result1 = await promise1;
      const result2 = await promise2;
      expect(result1.decision).toBe("timeout");
      expect(result2.decision).toBe("timeout");
    });

    it("clears all pending approvals and listeners", () => {
      const listener = vi.fn();
      channel.addListener(listener);
      channel.requestApproval(makeRequest());

      channel.destroy();

      expect(channel.getPendingApprovals()).toHaveLength(0);
      // After destroy, new requests don't notify removed listeners
      channel.requestApproval(makeRequest());
      expect(listener).toHaveBeenCalledOnce(); // Only the first time
    });
  });
});
