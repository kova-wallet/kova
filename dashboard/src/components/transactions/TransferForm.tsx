"use client";

import { useState } from "react";

interface TransactionResult {
  status: string;
  summary: string;
  txId?: string;
  error?: { code: string; message: string };
}

export default function TransferForm({
  onResult,
}: {
  onResult: (r: TransactionResult) => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("SOL");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/transactions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "transfer",
          params: { to, amount, token },
          metadata: reason ? { reason } : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-text-secondary mb-1">
          Recipient Address
        </label>
        <input
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
          placeholder="Solana address..."
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            Amount
          </label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            placeholder="0.01"
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="w-24">
          <label className="block text-sm text-text-secondary mb-1">
            Token
          </label>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm text-text-secondary mb-1">
          Reason (optional)
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this transfer needed?"
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={loading || !to || !amount}
        className="w-full bg-accent hover:bg-accent-hover text-white py-2.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Executing..." : "Send Transfer"}
      </button>
      {loading && (
        <p className="text-xs text-text-secondary">
          If this transaction requires approval, it will wait until you approve it
          in the Approval Center.
        </p>
      )}
    </form>
  );
}
