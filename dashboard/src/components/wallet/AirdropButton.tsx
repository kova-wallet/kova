"use client";

import { useState } from "react";

export default function AirdropButton({
  onSuccess,
}: {
  onSuccess?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAirdrop() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/wallet/airdrop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(`Airdropped ${data.amount} SOL`);
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Airdrop failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleAirdrop}
        disabled={loading}
        className="bg-success/20 text-success hover:bg-success/30 px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Requesting..." : "Request Airdrop (1 SOL)"}
      </button>
      {result && <p className="text-sm text-success mt-2">{result}</p>}
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
