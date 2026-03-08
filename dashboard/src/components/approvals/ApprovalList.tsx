"use client";

import { useApprovalStream } from "@/hooks/useApprovalStream";
import ApprovalCard from "./ApprovalCard";

export default function ApprovalList() {
  const { approvals, connected, respond } = useApprovalStream();

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <span
          className={`w-2 h-2 rounded-full ${
            connected ? "bg-success" : "bg-danger"
          }`}
        />
        <span className="text-xs text-text-secondary">
          {connected ? "Connected to approval stream" : "Disconnected"}
        </span>
        {approvals.length > 0 && (
          <span className="ml-auto bg-accent/20 text-accent text-xs px-2 py-0.5 rounded-full">
            {approvals.length} pending
          </span>
        )}
      </div>

      {approvals.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-8 text-center">
          <p className="text-text-secondary text-sm">
            No pending approval requests.
          </p>
          <p className="text-text-secondary text-xs mt-2">
            When an agent sends a transaction above the approval threshold, it
            will appear here for your review.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((req) => (
            <ApprovalCard
              key={req.id}
              request={req}
              onRespond={respond}
            />
          ))}
        </div>
      )}
    </div>
  );
}
