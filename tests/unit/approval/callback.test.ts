import { describe, it, expect, vi, beforeEach } from "vitest";
import { CallbackApprovalChannel } from "../../../src/approval/callback.js";
import type { ApprovalRequest, ApprovalResult } from "../../../src/approval/interface.js";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    summary: "transfer 10.0 SOL",
    amount: "10.0",
    token: "SOL",
    target: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    expiresAt: Date.now() + 300_000,
    intentHash: "abc123def456",
    ...overrides,
  };
}

describe("CallbackApprovalChannel", () => {
  let onApprovalRequest: ReturnType<typeof vi.fn>;
  let waitForDecision: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onApprovalRequest = vi.fn().mockResolvedValue(undefined);
    waitForDecision = vi.fn();
  });

  it("has the correct default name", () => {
    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });
    expect(channel.name).toBe("callback");
  });

  it("accepts a custom name", () => {
    const channel = new CallbackApprovalChannel({
      name: "my-channel",
      onApprovalRequest,
      waitForDecision,
    });
    expect(channel.name).toBe("my-channel");
  });

  it("throws if onApprovalRequest is not a function", () => {
    expect(() => new CallbackApprovalChannel({
      onApprovalRequest: "not-a-function" as never,
      waitForDecision,
    })).toThrow("requires an onApprovalRequest callback");
  });

  it("throws if waitForDecision is not a function", () => {
    expect(() => new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision: "not-a-function" as never,
    })).toThrow("requires a waitForDecision callback");
  });

  it("throws if defaultTimeout is invalid", () => {
    expect(() => new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
      defaultTimeout: -1,
    })).toThrow("positive finite number");

    expect(() => new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
      defaultTimeout: Infinity,
    })).toThrow("positive finite number");
  });

  it("calls onApprovalRequest with the full request", async () => {
    const request = makeRequest();
    const result: ApprovalResult = {
      requestId: "req-1",
      decision: "approved",
      decidedAt: Date.now(),
    };
    waitForDecision.mockResolvedValue(result);

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    await channel.requestApproval(request);
    expect(onApprovalRequest).toHaveBeenCalledWith(request);
  });

  it("returns approved decision from waitForDecision", async () => {
    const request = makeRequest();
    const expected: ApprovalResult = {
      requestId: "req-1",
      decision: "approved",
      decidedBy: "Alice",
      decidedAt: Date.now(),
      intentHash: "abc123def456",
    };
    waitForDecision.mockResolvedValue(expected);

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    const result = await channel.requestApproval(request);
    expect(result.decision).toBe("approved");
    expect(result.decidedBy).toBe("Alice");
  });

  it("returns rejected decision from waitForDecision", async () => {
    const request = makeRequest();
    const expected: ApprovalResult = {
      requestId: "req-1",
      decision: "rejected",
      decidedBy: "Bob",
      decidedAt: Date.now(),
    };
    waitForDecision.mockResolvedValue(expected);

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    const result = await channel.requestApproval(request);
    expect(result.decision).toBe("rejected");
  });

  it("returns timeout when waitForDecision exceeds timeout", async () => {
    const request = makeRequest({
      expiresAt: Date.now() + 50, // 50ms timeout
    });
    // waitForDecision never resolves
    waitForDecision.mockReturnValue(new Promise(() => {}));

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    const result = await channel.requestApproval(request);
    expect(result.decision).toBe("timeout");
    expect(result.requestId).toBe("req-1");
    expect(result.intentHash).toBe("abc123def456");
  }, 10_000);

  it("uses defaultTimeout when expiresAt is not set", async () => {
    const request = makeRequest({ expiresAt: 0 });
    waitForDecision.mockReturnValue(new Promise(() => {}));

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
      defaultTimeout: 50, // 50ms
    });

    const result = await channel.requestApproval(request);
    expect(result.decision).toBe("timeout");
  }, 10_000);

  it("propagates errors from onApprovalRequest", async () => {
    onApprovalRequest.mockRejectedValue(new Error("send failed"));
    const request = makeRequest();

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    await expect(channel.requestApproval(request)).rejects.toThrow("send failed");
  });

  it("propagates errors from waitForDecision", async () => {
    waitForDecision.mockRejectedValue(new Error("poll failed"));
    const request = makeRequest();

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    await expect(channel.requestApproval(request)).rejects.toThrow("poll failed");
  });

  it("passes through requestedByUserId in the request", async () => {
    const request = makeRequest({ requestedByUserId: "user-123" });
    const expected: ApprovalResult = {
      requestId: "req-1",
      decision: "approved",
      decidedAt: Date.now(),
    };
    waitForDecision.mockResolvedValue(expected);

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    await channel.requestApproval(request);
    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedByUserId: "user-123" }),
    );
  });

  it("passes through intentHash in the request", async () => {
    const request = makeRequest({ intentHash: "deadbeef" });
    const expected: ApprovalResult = {
      requestId: "req-1",
      decision: "approved",
      decidedAt: Date.now(),
    };
    waitForDecision.mockResolvedValue(expected);

    const channel = new CallbackApprovalChannel({
      onApprovalRequest,
      waitForDecision,
    });

    await channel.requestApproval(request);
    expect(waitForDecision).toHaveBeenCalledWith(
      expect.objectContaining({ intentHash: "deadbeef" }),
    );
  });
});
