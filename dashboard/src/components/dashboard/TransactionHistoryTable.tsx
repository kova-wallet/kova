"use client";

import { usePolling } from "@/hooks/usePolling";

interface TransactionResult {
  status: "confirmed" | "denied" | "failed" | "pending";
  txId?: string;
  summary: string;
  intentId: string;
  timestamp: number;
  error?: { code: string; message: string };
}

const statusColors: Record<string, string> = {
  confirmed: "bg-success/20 text-success",
  denied: "bg-danger/20 text-danger",
  failed: "bg-danger/20 text-danger",
  pending: "bg-pending/20 text-pending",
};

export default function TransactionHistoryTable() {
  const { data, loading } = usePolling<TransactionResult[]>(
    "/api/transactions?limit=20",
    10_000
  );

  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-4">
        Recent Transactions
      </h3>

      {loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-surface-hover rounded animate-pulse" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <p className="text-text-secondary text-sm">No transactions yet</p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {data.map((tx) => (
            <div
              key={tx.intentId}
              className="flex items-center gap-3 p-3 bg-background rounded-md"
            >
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  statusColors[tx.status] ?? "bg-surface-hover text-text-secondary"
                }`}
              >
                {tx.status}
              </span>
              <span className="text-sm text-text-primary flex-1 truncate">
                {tx.summary}
              </span>
              <span className="text-xs text-text-secondary">
                {new Date(tx.timestamp).toLocaleTimeString()}
              </span>
              {tx.txId && (
                <a
                  href={`https://explorer.solana.com/tx/${tx.txId}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:text-accent-hover"
                >
                  View
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
