"use client";

import { useState, useEffect } from "react";
import BalanceCard from "@/components/dashboard/BalanceCard";
import PolicySummaryCard from "@/components/dashboard/PolicySummaryCard";
import TransactionHistoryTable from "@/components/dashboard/TransactionHistoryTable";

export default function DashboardPage() {
  const [walletStatus, setWalletStatus] = useState<{
    initialized: boolean;
    address: string | null;
  } | null>(null);

  useEffect(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then(setWalletStatus);
  }, []);

  if (!walletStatus) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!walletStatus.initialized) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
        <div className="bg-surface border border-border rounded-lg p-8 text-center">
          <p className="text-text-secondary mb-4">
            No wallet has been created yet.
          </p>
          <a
            href="/wallet"
            className="inline-block bg-accent hover:bg-accent-hover text-white px-6 py-2.5 rounded-md text-sm font-medium transition-colors"
          >
            Create Wallet
          </a>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-sm text-text-secondary font-mono">
            {walletStatus.address?.slice(0, 8)}...{walletStatus.address?.slice(-4)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <BalanceCard />
        <PolicySummaryCard />
      </div>

      <TransactionHistoryTable />
    </div>
  );
}
