/**
 * DashboardApprovalChannel — Web-based approval channel for the Kova SDK.
 *
 * Implements the SDK's ApprovalChannel interface. When the PolicyEngine triggers
 * an approval gate, this channel stores the pending request and notifies
 * SSE listeners in the browser. The user approves/denies via the web UI,
 * which resolves the pending Promise and unblocks the SDK pipeline.
 */

import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
} from "@kova/approval/interface.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  createdAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type ApprovalListener = (request: ApprovalRequest) => void;

export class DashboardApprovalChannel implements ApprovalChannel {
  readonly name = "dashboard";

  private pending = new Map<string, PendingApproval>();
  private listeners = new Set<ApprovalListener>();

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const timeoutMs = Math.max(0, request.expiresAt - Date.now());

      const timeoutHandle = setTimeout(() => {
        this.pending.delete(request.id);
        resolve({
          requestId: request.id,
          decision: "timeout",
          decidedAt: Date.now(),
          intentHash: request.intentHash,
        });
      }, timeoutMs);

      this.pending.set(request.id, {
        request,
        resolve,
        createdAt: Date.now(),
        timeoutHandle,
      });

      // Notify all SSE listeners
      for (const listener of this.listeners) {
        try {
          listener(request);
        } catch {
          // Non-fatal — listener may have disconnected
        }
      }
    });
  }

  /** Called by POST /api/approvals/[id] to resolve a pending approval */
  respondToApproval(
    requestId: string,
    decision: "approved" | "rejected",
    decidedBy?: string
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(requestId);

    pending.resolve({
      requestId,
      decision,
      decidedBy: decidedBy ?? "dashboard-user",
      decidedAt: Date.now(),
      intentHash: pending.request.intentHash,
    });

    return true;
  }

  /** Get all currently pending approval requests */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  /** Register an SSE listener for new approval requests */
  addListener(listener: ApprovalListener): void {
    this.listeners.add(listener);
  }

  /** Remove an SSE listener */
  removeListener(listener: ApprovalListener): void {
    this.listeners.delete(listener);
  }

  /** Clean up all pending approvals */
  destroy(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve({
        requestId: id,
        decision: "timeout",
        decidedAt: Date.now(),
      });
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
