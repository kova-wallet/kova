/**
 * WebhookApprovalChannel — HTTP webhook-based approval channel.
 *
 * Flow:
 * 1. SDK POSTs the ApprovalRequest as JSON to the configured webhookUrl
 *    with an X-Kova-Signature header (HMAC-SHA256 of the body).
 * 2. The external system presents the request to a human approver.
 * 3. The external system POSTs the decision back to a callback server
 *    hosted by this channel, with an X-Kova-Signature header for verification.
 *
 * Security:
 * - HMAC-SHA256 signatures on both outbound and inbound requests prevent tampering.
 * - Private/reserved IP blocking on webhookUrl prevents SSRF.
 * - Timeout ensures fail-closed behavior (no response → DENY).
 * - TOCTOU protection and other security guarantees are handled by the policy engine.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
  ApprovalDecision,
} from "./interface.js";

const resolveDns = promisify(dnsLookup);

export interface WebhookApprovalChannelConfig {
  /**
   * Channel name for identification in audit logs.
   * Defaults to "webhook".
   */
  name?: string;

  /**
   * URL to POST approval requests to.
   * Must be HTTPS in production. HTTP is allowed for localhost only.
   */
  webhookUrl: string;

  /**
   * Shared secret for HMAC-SHA256 signing of outbound requests and
   * verification of inbound callbacks.
   */
  hmacSecret: string;

  /**
   * Port to listen on for incoming decision callbacks.
   * Defaults to 0 (OS-assigned ephemeral port).
   * Use getCallbackPort() after construction to discover the assigned port.
   */
  callbackPort?: number;

  /**
   * Path to listen on for incoming decision callbacks.
   * Defaults to "/approval/callback".
   */
  callbackPath?: string;

  /**
   * Default timeout in milliseconds. Defaults to 300_000 (5 minutes).
   */
  defaultTimeout?: number;
}

/** Expected shape of the inbound callback POST body */
interface CallbackBody {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy?: string;
  intentHash?: string;
}

/**
 * SSRF protection: Check if an IP address is private/reserved.
 * Validates against RFC 1918/4193/6890 private and reserved ranges.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private/reserved ranges
  if (/^127\./.test(ip)) return true;                          // loopback
  if (/^10\./.test(ip)) return true;                           // Class A private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;     // Class B private
  if (/^192\.168\./.test(ip)) return true;                     // Class C private
  if (/^169\.254\./.test(ip)) return true;                     // link-local
  if (/^0\./.test(ip)) return true;                            // "this" network
  if (ip === "255.255.255.255") return true;                   // broadcast
  // IPv6 private/reserved
  if (ip === "::1") return true;                               // loopback
  if (/^fe80:/i.test(ip)) return true;                         // link-local
  if (/^fc00:/i.test(ip) || /^fd/i.test(ip)) return true;     // unique local
  return false;
}

export class WebhookApprovalChannel implements ApprovalChannel {
  readonly name: string;
  private readonly config: WebhookApprovalChannelConfig;
  private readonly defaultTimeout: number;
  private readonly callbackPath: string;
  private server: Server | null = null;
  private pendingRequests = new Map<string, {
    resolve: (result: ApprovalResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private destroyed = false;

  constructor(config: WebhookApprovalChannelConfig) {
    if (!config.webhookUrl) {
      throw new Error("WebhookApprovalChannel requires a webhookUrl");
    }
    if (!config.hmacSecret || config.hmacSecret.length < 16) {
      throw new Error("WebhookApprovalChannel requires an hmacSecret of at least 16 characters");
    }
    this.config = config;
    this.name = config.name ?? "webhook";
    this.defaultTimeout = config.defaultTimeout ?? 300_000;
    this.callbackPath = config.callbackPath ?? "/approval/callback";

    if (this.defaultTimeout <= 0 || !Number.isFinite(this.defaultTimeout)) {
      throw new Error("WebhookApprovalChannel: defaultTimeout must be a positive finite number");
    }
  }

  /**
   * Start the callback HTTP server. Must be called before requestApproval().
   * Separated from constructor to allow async initialization.
   */
  async start(): Promise<void> {
    if (this.server) return;

    // SSRF protection: validate webhookUrl doesn't resolve to private IP
    await this.validateWebhookUrl();

    this.server = createServer((req, res) => this.handleCallback(req, res));
    const port = this.config.callbackPort ?? 0;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => resolve());
      this.server!.once("error", reject);
    });
  }

  /**
   * Get the port the callback server is listening on.
   * Useful when callbackPort is 0 (OS-assigned).
   */
  getCallbackPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") return addr.port;
    throw new Error("WebhookApprovalChannel: server not started or not listening");
  }

  /**
   * Get the full callback URL that the external system should POST decisions to.
   */
  getCallbackUrl(): string {
    return `http://localhost:${this.getCallbackPort()}${this.callbackPath}`;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (this.destroyed) {
      throw new Error("WebhookApprovalChannel has been destroyed and can no longer process requests");
    }
    if (!this.server) {
      throw new Error("WebhookApprovalChannel: call start() before requestApproval()");
    }

    // Build the outbound payload — include the callbackUrl so the receiver knows where to POST back
    const payload = JSON.stringify({
      ...request,
      callbackUrl: this.getCallbackUrl(),
    });

    const signature = this.computeHmac(payload);

    // POST the approval request to the webhook URL
    const response = await fetch(this.config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kova-Signature": signature,
      },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(
        `WebhookApprovalChannel: webhook returned ${response.status} ${response.statusText}`,
      );
    }

    // Wait for the callback with timeout
    const timeoutMs = request.expiresAt
      ? Math.max(request.expiresAt - Date.now(), 0)
      : this.defaultTimeout;

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        resolve({
          requestId: request.id,
          decision: "timeout",
          decidedAt: Date.now(),
          intentHash: request.intentHash,
        });
      }, timeoutMs);

      // Unref the timer so it doesn't keep the process alive
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.pendingRequests.set(request.id, { resolve, timer });
    });
  }

  /**
   * Shut down the callback server and clean up pending requests.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;

    // Resolve all pending requests as timeout
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        decision: "timeout",
        decidedAt: Date.now(),
      });
    }
    this.pendingRequests.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  /** Compute HMAC-SHA256 signature for a payload */
  private computeHmac(payload: string): string {
    return createHmac("sha256", this.config.hmacSecret)
      .update(payload)
      .digest("hex");
  }

  /** Verify HMAC-SHA256 signature using timing-safe comparison */
  private verifyHmac(payload: string, signature: string): boolean {
    const expected = this.computeHmac(payload);
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  }

  /** Handle incoming callback POST */
  private handleCallback(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST to the callback path
    if (req.method !== "POST" || req.url !== this.callbackPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf-8");

      // Verify HMAC signature
      const signature = req.headers["x-kova-signature"];
      if (!signature || typeof signature !== "string" || !this.verifyHmac(bodyStr, signature)) {
        res.writeHead(401);
        res.end("Unauthorized: invalid signature");
        return;
      }

      // Parse the callback body
      let body: CallbackBody;
      try {
        body = JSON.parse(bodyStr) as CallbackBody;
      } catch {
        res.writeHead(400);
        res.end("Bad Request: invalid JSON");
        return;
      }

      // Validate required fields
      if (!body.requestId || !body.decision) {
        res.writeHead(400);
        res.end("Bad Request: missing requestId or decision");
        return;
      }

      // Validate decision value
      const validDecisions: ApprovalDecision[] = ["approved", "rejected", "timeout"];
      if (!validDecisions.includes(body.decision)) {
        res.writeHead(400);
        res.end("Bad Request: decision must be 'approved', 'rejected', or 'timeout'");
        return;
      }

      // Look up the pending request
      const pending = this.pendingRequests.get(body.requestId);
      if (!pending) {
        res.writeHead(404);
        res.end("Not Found: no pending request with this ID");
        return;
      }

      // Resolve the pending request
      clearTimeout(pending.timer);
      this.pendingRequests.delete(body.requestId);

      pending.resolve({
        requestId: body.requestId,
        decision: body.decision,
        decidedBy: body.decidedBy,
        decidedAt: Date.now(),
        intentHash: body.intentHash,
      });

      res.writeHead(200);
      res.end("OK");
    });
  }

  /** SSRF protection: validate webhookUrl doesn't resolve to a private IP */
  private async validateWebhookUrl(): Promise<void> {
    const parsed = new URL(this.config.webhookUrl);
    const hostname = parsed.hostname;

    // Allow localhost for development
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return;
    }

    // Require HTTPS for non-localhost
    if (parsed.protocol !== "https:") {
      throw new Error(
        `WebhookApprovalChannel: webhookUrl must use HTTPS (got ${parsed.protocol}). ` +
        `HTTP is only allowed for localhost.`,
      );
    }

    // Resolve hostname and check for private IPs
    try {
      const result = await resolveDns(hostname, { all: false });
      const address = typeof result === "string" ? result : result.address;
      if (isPrivateIp(address)) {
        throw new Error(
          `WebhookApprovalChannel: webhookUrl hostname "${hostname}" resolved to private IP ${address} (possible SSRF)`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("WebhookApprovalChannel")) {
        throw err; // Re-throw our own errors
      }
      throw new Error(
        `WebhookApprovalChannel: failed to resolve webhookUrl hostname "${hostname}": ${err}`,
      );
    }
  }
}
