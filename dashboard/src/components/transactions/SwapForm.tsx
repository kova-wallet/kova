"use client";

import { useState } from "react";

interface TransactionResult {
  status: string;
  summary: string;
  txId?: string;
  error?: { code: string; message: string };
}

export default function SwapForm({
  onResult,
}: {
  onResult: (r: TransactionResult) => void;
}) {
  const [fromToken, setFromToken] = useState("SOL");
  const [toToken, setToToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [maxSlippage, setMaxSlippage] = useState("0.5");
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
          type: "swap",
          params: {
            fromToken,
            toToken,
            amount,
            maxSlippage: parseFloat(maxSlippage) / 100,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            From Token
          </label>
          <input
            type="text"
            value={fromToken}
            onChange={(e) => setFromToken(e.target.value)}
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            To Token
          </label>
          <input
            type="text"
            value={toToken}
            onChange={(e) => setToToken(e.target.value)}
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
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
            placeholder="1.0"
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="w-28">
          <label className="block text-sm text-text-secondary mb-1">
            Slippage %
          </label>
          <input
            type="text"
            value={maxSlippage}
            onChange={(e) => setMaxSlippage(e.target.value)}
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount}
        className="w-full bg-accent hover:bg-accent-hover text-white py-2.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Executing..." : "Execute Swap"}
      </button>
    </form>
  );
}
