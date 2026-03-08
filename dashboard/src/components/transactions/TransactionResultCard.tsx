"use client";

interface TransactionResult {
  status: string;
  summary: string;
  txId?: string;
  error?: { code: string; message: string };
}

const statusStyles: Record<string, string> = {
  confirmed: "border-success/30 bg-success/5",
  denied: "border-danger/30 bg-danger/5",
  failed: "border-danger/30 bg-danger/5",
  pending: "border-pending/30 bg-pending/5",
};

const statusBadge: Record<string, string> = {
  confirmed: "bg-success/20 text-success",
  denied: "bg-danger/20 text-danger",
  failed: "bg-danger/20 text-danger",
  pending: "bg-pending/20 text-pending",
};

export default function TransactionResultCard({
  result,
}: {
  result: TransactionResult;
}) {
  return (
    <div
      className={`border rounded-lg p-4 ${
        statusStyles[result.status] ?? "border-border"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            statusBadge[result.status] ?? "bg-surface text-text-secondary"
          }`}
        >
          {result.status.toUpperCase()}
        </span>
      </div>
      <p className="text-sm text-text-primary mb-2">{result.summary}</p>
      {result.txId && (
        <a
          href={`https://explorer.solana.com/tx/${result.txId}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:text-accent-hover font-mono"
        >
          {result.txId}
        </a>
      )}
      {result.error && (
        <p className="text-xs text-danger mt-2">
          [{result.error.code}] {result.error.message}
        </p>
      )}
    </div>
  );
}
