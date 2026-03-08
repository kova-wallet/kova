"use client";

import { usePolling } from "@/hooks/usePolling";

interface TokenBalance {
  token: string;
  amount: string;
  decimals: number;
  usdValue?: number;
}

export default function BalanceCard() {
  const { data, loading } = usePolling<TokenBalance>(
    "/api/wallet/balance?token=SOL",
    15_000
  );

  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
        SOL Balance
      </h3>
      {loading && !data ? (
        <div className="h-10 w-32 bg-surface-hover rounded animate-pulse" />
      ) : (
        <p className="text-3xl font-bold">
          {data?.amount ?? "—"}{" "}
          <span className="text-lg text-text-secondary">SOL</span>
        </p>
      )}
    </div>
  );
}
