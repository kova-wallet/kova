"use client";

import { useState, useEffect, useCallback } from "react";

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

export function useApprovalStream() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/approvals/stream");

      source.onopen = () => setConnected(true);

      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            setConnected(true);
          } else if (data.type === "new") {
            setApprovals((prev) => {
              if (prev.find((a) => a.id === data.approval.id)) return prev;
              return [...prev, data.approval];
            });
          } else if (data.type === "resolved") {
            setApprovals((prev) => prev.filter((a) => a.id !== data.id));
          }
        } catch {
          // Ignore malformed events
        }
      };

      source.onerror = () => {
        setConnected(false);
        source?.close();
        // Auto-reconnect after 3 seconds
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 3_000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  const respond = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      }
      return res.ok;
    },
    []
  );

  return { approvals, connected, respond };
}
