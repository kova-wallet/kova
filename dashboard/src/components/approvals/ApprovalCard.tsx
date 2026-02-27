"use client";

import { useState, useEffect } from "react";

interface ApprovalRequest {
  id: string;
  summary: string;
  amount: string;
  token: string;
  usdValue?: number;
  target: string;
  reason?: string;
  agentId?: string;
  budgetContext?: {
    dailySpent: string;
    dailyLimit: string;
    token: string;
  };
  expiresAt: number;
  intentHash?: string;
}

export default function ApprovalCard({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (id: string, decision: "approved" | "rejected") => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    setTimeLeft(Math.max(0, request.expiresAt - Date.now()));
    const id = setInterval(() => {
      setTimeLeft(Math.max(0, request.expiresAt - Date.now()));
    }, 1_000);
    return () => clearInterval(id);
  }, [request.expiresAt]);

  async function handleDecision(decision: "approved" | "rejected") {
    setLoading(decision);
    onRespond(request.id, decision);
  }

  const seconds = Math.floor(timeLeft / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;

  return (
    <div className="bg-surface border border-border rounded-lg p-5 hover:border-accent/30 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-sm font-medium text-text-primary">
          {request.summary}
        </h3>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            timeLeft > 30_000
              ? "bg-warning/20 text-warning"
              : "bg-danger/20 text-danger"
          }`}
        >
          {minutes}:{remainSec.toString().padStart(2, "0")}
        </span>
      </div>

      <div className="space-y-2 text-sm mb-4">
        <div className="flex justify-between">
          <span className="text-text-secondary">Amount</span>
          <span className="font-medium">
            {request.amount} {request.token}
            {request.usdValue != null && (
              <span className="text-text-secondary ml-1">
                (${request.usdValue.toFixed(2)})
              </span>
            )}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-text-secondary">Target</span>
          <span className="font-mono text-xs">
            {request.target.slice(0, 8)}...{request.target.slice(-4)}
          </span>
        </div>

        {request.reason && (
          <div>
            <span className="text-text-secondary">Reason</span>
            <p className="text-xs text-text-secondary mt-0.5 italic">
              {request.reason}
            </p>
          </div>
        )}

        {request.agentId && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Agent</span>
            <span className="text-xs">{request.agentId}</span>
          </div>
        )}

        {request.budgetContext && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Daily budget</span>
            <span className="text-xs">
              {request.budgetContext.dailySpent} / {request.budgetContext.dailyLimit}{" "}
              {request.budgetContext.token}
            </span>
          </div>
        )}

        {request.intentHash && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Intent hash</span>
            <span className="font-mono text-xs text-text-secondary">
              {request.intentHash.slice(0, 16)}...
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => handleDecision("approved")}
          disabled={loading !== null || timeLeft === 0}
          className="flex-1 bg-success/20 text-success hover:bg-success/30 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
        >
          {loading === "approved" ? "Approving..." : "Approve"}
        </button>
        <button
          onClick={() => handleDecision("rejected")}
          disabled={loading !== null || timeLeft === 0}
          className="flex-1 bg-danger/20 text-danger hover:bg-danger/30 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
        >
          {loading === "rejected" ? "Rejecting..." : "Reject"}
        </button>
      </div>
    </div>
  );
}
