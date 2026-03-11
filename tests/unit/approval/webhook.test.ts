import { createHmac } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { WebhookApprovalChannel } from "../../../src/approval/webhook.js";
import type { ApprovalRequest } from "../../../src/approval/interface.js";

const HMAC_SECRET = "test-secret-at-least-16-chars";

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

function computeHmac(payload: string, secret = HMAC_SECRET): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("WebhookApprovalChannel", () => {
  let channel: WebhookApprovalChannel | null = null;

  afterEach(async () => {
    if (channel) {
      await channel.destroy();
      channel = null;
    }
  });

  it("throws if webhookUrl is empty", () => {
    expect(() => new WebhookApprovalChannel({
      webhookUrl: "",
      hmacSecret: HMAC_SECRET,
    })).toThrow("requires a webhookUrl");
  });

  it("throws if hmacSecret is too short", () => {
    expect(() => new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: "short",
    })).toThrow("at least 16 characters");
  });

  it("throws if defaultTimeout is invalid", () => {
    expect(() => new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      defaultTimeout: -100,
    })).toThrow("positive finite number");
  });

  it("has the correct default name", () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
    });
    expect(channel.name).toBe("webhook");
  });

  it("accepts a custom name", () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      name: "my-webhook",
    });
    expect(channel.name).toBe("my-webhook");
  });

  it("throws if requestApproval called before start()", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
    });
    await expect(channel.requestApproval(makeRequest())).rejects.toThrow("call start()");
  });

  it("starts callback server and exposes port", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      callbackPort: 0,
    });
    await channel.start();
    const port = channel.getCallbackPort();
    expect(port).toBeGreaterThan(0);
  });

  it("sends POST with HMAC signature and resolves on callback", async () => {
    // Start a local "webhook receiver" to capture the outbound POST
    const { createServer } = await import("node:http");
    let receivedBody = "";
    let receivedSignature = "";
    const webhookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf-8");
        receivedSignature = req.headers["x-kova-signature"] as string;
        res.writeHead(200);
        res.end("OK");
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    const webhookPort = (webhookServer.address() as { port: number }).port;

    try {
      channel = new WebhookApprovalChannel({
        webhookUrl: `http://localhost:${webhookPort}/receive`,
        hmacSecret: HMAC_SECRET,
        callbackPort: 0,
      });
      await channel.start();

      const request = makeRequest({ expiresAt: Date.now() + 10_000 });

      // Start the approval request (it will POST to our webhook server and then wait for callback)
      const approvalPromise = channel.requestApproval(request);

      // Wait briefly for the POST to arrive
      await new Promise((r) => setTimeout(r, 200));

      // Verify the outbound POST had the correct HMAC
      expect(receivedSignature).toBe(computeHmac(receivedBody));
      const parsed = JSON.parse(receivedBody);
      expect(parsed.id).toBe("req-1");
      expect(parsed.callbackUrl).toContain("/approval/callback");

      // Now POST a decision back to the callback server
      const callbackUrl = channel.getCallbackUrl();
      const decisionBody = JSON.stringify({
        requestId: "req-1",
        decision: "approved",
        decidedBy: "Alice",
      });
      const decisionSignature = computeHmac(decisionBody);

      await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kova-Signature": decisionSignature,
        },
        body: decisionBody,
      });

      const result = await approvalPromise;
      expect(result.decision).toBe("approved");
      expect(result.decidedBy).toBe("Alice");
      expect(result.requestId).toBe("req-1");
    } finally {
      webhookServer.close();
    }
  }, 15_000);

  it("rejects callback with invalid HMAC", async () => {
    const { createServer } = await import("node:http");
    const webhookServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    const webhookPort = (webhookServer.address() as { port: number }).port;

    try {
      channel = new WebhookApprovalChannel({
        webhookUrl: `http://localhost:${webhookPort}/receive`,
        hmacSecret: HMAC_SECRET,
        callbackPort: 0,
      });
      await channel.start();

      const request = makeRequest({ expiresAt: Date.now() + 5_000 });
      const _approvalPromise = channel.requestApproval(request);

      await new Promise((r) => setTimeout(r, 100));

      // Send callback with bad signature
      const callbackUrl = channel.getCallbackUrl();
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kova-Signature": "bad-signature",
        },
        body: JSON.stringify({ requestId: "req-1", decision: "approved" }),
      });

      expect(response.status).toBe(401);

      // Clean up — destroy will resolve the pending request as timeout
      await channel.destroy();
      channel = null;
    } finally {
      webhookServer.close();
    }
  }, 15_000);

  it("returns timeout when no callback arrives", async () => {
    const { createServer } = await import("node:http");
    const webhookServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    const webhookPort = (webhookServer.address() as { port: number }).port;

    try {
      channel = new WebhookApprovalChannel({
        webhookUrl: `http://localhost:${webhookPort}/receive`,
        hmacSecret: HMAC_SECRET,
        callbackPort: 0,
      });
      await channel.start();

      const request = makeRequest({ expiresAt: Date.now() + 100 }); // 100ms timeout

      const result = await channel.requestApproval(request);
      expect(result.decision).toBe("timeout");
      expect(result.requestId).toBe("req-1");
    } finally {
      webhookServer.close();
    }
  }, 15_000);

  it("handles concurrent approval requests", async () => {
    const { createServer } = await import("node:http");
    const webhookServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    const webhookPort = (webhookServer.address() as { port: number }).port;

    try {
      channel = new WebhookApprovalChannel({
        webhookUrl: `http://localhost:${webhookPort}/receive`,
        hmacSecret: HMAC_SECRET,
        callbackPort: 0,
      });
      await channel.start();

      const req1 = makeRequest({ id: "req-1", expiresAt: Date.now() + 10_000 });
      const req2 = makeRequest({ id: "req-2", expiresAt: Date.now() + 10_000 });

      const promise1 = channel.requestApproval(req1);
      const promise2 = channel.requestApproval(req2);

      await new Promise((r) => setTimeout(r, 200));

      const callbackUrl = channel.getCallbackUrl();

      // Resolve req-2 first (out of order)
      const body2 = JSON.stringify({ requestId: "req-2", decision: "rejected", decidedBy: "Bob" });
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kova-Signature": computeHmac(body2) },
        body: body2,
      });

      // Then resolve req-1
      const body1 = JSON.stringify({ requestId: "req-1", decision: "approved", decidedBy: "Alice" });
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kova-Signature": computeHmac(body1) },
        body: body1,
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1.decision).toBe("approved");
      expect(result1.decidedBy).toBe("Alice");
      expect(result2.decision).toBe("rejected");
      expect(result2.decidedBy).toBe("Bob");
    } finally {
      webhookServer.close();
    }
  }, 15_000);

  it("destroy resolves all pending requests as timeout", async () => {
    const { createServer } = await import("node:http");
    const webhookServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    const webhookPort = (webhookServer.address() as { port: number }).port;

    try {
      channel = new WebhookApprovalChannel({
        webhookUrl: `http://localhost:${webhookPort}/receive`,
        hmacSecret: HMAC_SECRET,
        callbackPort: 0,
      });
      await channel.start();

      const request = makeRequest({ expiresAt: Date.now() + 60_000 });
      const promise = channel.requestApproval(request);

      await new Promise((r) => setTimeout(r, 100));

      await channel.destroy();
      channel = null;

      const result = await promise;
      expect(result.decision).toBe("timeout");
    } finally {
      webhookServer.close();
    }
  }, 15_000);

  it("throws after destroy", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
    });
    await channel.start();
    await channel.destroy();

    await expect(channel.requestApproval(makeRequest())).rejects.toThrow("destroyed");
    channel = null;
  });

  it("returns 404 for non-callback paths", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      callbackPort: 0,
    });
    await channel.start();

    const port = channel.getCallbackPort();
    const response = await fetch(`http://localhost:${port}/wrong-path`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid JSON callback body", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      callbackPort: 0,
    });
    await channel.start();

    const callbackUrl = channel.getCallbackUrl();
    const badBody = "not json";
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kova-Signature": computeHmac(badBody),
      },
      body: badBody,
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for missing required fields", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      callbackPort: 0,
    });
    await channel.start();

    const callbackUrl = channel.getCallbackUrl();
    const body = JSON.stringify({ requestId: "req-1" }); // missing decision
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kova-Signature": computeHmac(body),
      },
      body,
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid decision value", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://localhost:9999/test",
      hmacSecret: HMAC_SECRET,
      callbackPort: 0,
    });
    await channel.start();

    const callbackUrl = channel.getCallbackUrl();
    const body = JSON.stringify({ requestId: "req-1", decision: "maybe" });
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kova-Signature": computeHmac(body),
      },
      body,
    });
    expect(response.status).toBe(400);
  });

  it("SSRF: rejects non-HTTPS webhookUrl for non-localhost", async () => {
    channel = new WebhookApprovalChannel({
      webhookUrl: "http://example.com/webhook",
      hmacSecret: HMAC_SECRET,
    });

    await expect(channel.start()).rejects.toThrow("must use HTTPS");
  });
});
