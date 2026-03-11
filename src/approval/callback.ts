/**
 * CallbackApprovalChannel — A flexible approval channel that delegates notification
 * and decision collection to developer-provided callbacks.
 *
 * This is the most flexible channel: devs provide their own logic for how to notify
 * a human (webhook, push notification, Slack, Discord, email, SMS, in-app UI, etc.)
 * and how to collect the decision (webhook listener, polling endpoint, WebSocket, etc.).
 *
 * Security guarantees (TOCTOU intent hashing, fail-closed timeout, self-approval
 * prevention, rate limiting) are handled by ApprovalGateRule in the policy engine,
 * NOT by the channel. The channel is purely a notification/decision-collection transport.
 */

import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
} from "./interface.js";

export interface CallbackApprovalChannelConfig {
  /**
   * Channel name for identification in audit logs.
   * Defaults to "callback".
   */
  name?: string;

  /**
   * Called when an approval request is created. Use this to notify a human
   * through whatever mechanism you prefer (webhook, push notification, etc.).
   *
   * If this throws, the approval is treated as a channel error and the
   * ApprovalGateRule will DENY the transaction (fail-closed).
   */
  onApprovalRequest: (request: ApprovalRequest) => Promise<void>;

  /**
   * Called to wait for the human's decision. Must return a Promise that resolves
   * with the ApprovalResult when the human approves or rejects.
   *
   * This function should block until a decision is available. The channel will
   * race this against the timeout — if the timeout fires first, the request
   * is automatically resolved as "timeout" (DENY).
   *
   * If this throws, the approval is treated as a channel error and the
   * ApprovalGateRule will DENY the transaction (fail-closed).
   */
  waitForDecision: (request: ApprovalRequest) => Promise<ApprovalResult>;

  /**
   * Default timeout in milliseconds. Defaults to 300_000 (5 minutes).
   * After this duration, if no decision has been received, the request
   * resolves as "timeout" (which maps to DENY in the policy engine).
   */
  defaultTimeout?: number;
}

export class CallbackApprovalChannel implements ApprovalChannel {
  readonly name: string;
  private readonly config: CallbackApprovalChannelConfig;
  private readonly defaultTimeout: number;

  constructor(config: CallbackApprovalChannelConfig) {
    if (typeof config.onApprovalRequest !== "function") {
      throw new Error("CallbackApprovalChannel requires an onApprovalRequest callback");
    }
    if (typeof config.waitForDecision !== "function") {
      throw new Error("CallbackApprovalChannel requires a waitForDecision callback");
    }
    this.config = config;
    this.name = config.name ?? "callback";
    this.defaultTimeout = config.defaultTimeout ?? 300_000;

    if (this.defaultTimeout <= 0 || !Number.isFinite(this.defaultTimeout)) {
      throw new Error("CallbackApprovalChannel: defaultTimeout must be a positive finite number");
    }
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    // Notify the human — if this throws, let it propagate (fail-closed in ApprovalGateRule)
    await this.config.onApprovalRequest(request);

    // Race the decision against the timeout
    const timeoutMs = request.expiresAt
      ? Math.max(request.expiresAt - Date.now(), 0)
      : this.defaultTimeout;

    const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
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
    });

    const decisionPromise = this.config.waitForDecision(request);

    return Promise.race([decisionPromise, timeoutPromise]);
  }
}
