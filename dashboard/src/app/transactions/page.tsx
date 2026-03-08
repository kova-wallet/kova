"use client";

import { useState, useEffect } from "react";
import TransferForm from "@/components/transactions/TransferForm";
import SwapForm from "@/components/transactions/SwapForm";
import TransactionResultCard from "@/components/transactions/TransactionResultCard";

interface TransactionResult {
  status: string;
  summary: string;
  txId?: string;
  error?: { code: string; message: string };
}

export default function TransactionsPage() {
  const [tab, setTab] = useState<"transfer" | "swap">("transfer");
  const [results, setResults] = useState<TransactionResult[]>([]);
  const [initialized, setInitialized] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => setInitialized(d.initialized));
  }, []);

  function handleResult(r: TransactionResult) {
    setResults((prev) => [r, ...prev]);
  }

  if (initialized === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!initialized) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Transactions</h1>
        <div className="bg-surface border border-border rounded-lg p-8 text-center">
          <p className="text-text-secondary mb-4">
            Create a wallet first to execute transactions.
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
      <h1 className="text-2xl font-bold mb-6">Execute Transaction</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-lg p-6">
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setTab("transfer")}
              className={`px-4 py-2 rounded-md text-sm transition-colors ${
                tab === "transfer"
                  ? "bg-accent text-white"
                  : "bg-surface-hover text-text-secondary hover:text-text-primary"
              }`}
            >
              Transfer
            </button>
            <button
              onClick={() => setTab("swap")}
              className={`px-4 py-2 rounded-md text-sm transition-colors ${
                tab === "swap"
                  ? "bg-accent text-white"
                  : "bg-surface-hover text-text-secondary hover:text-text-primary"
              }`}
            >
              Swap
            </button>
          </div>

          {tab === "transfer" ? (
            <TransferForm onResult={handleResult} />
          ) : (
            <SwapForm onResult={handleResult} />
          )}
        </div>

        <div>
          <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
            Results
          </h2>
          {results.length === 0 ? (
            <p className="text-sm text-text-secondary">
              Execute a transaction to see results here.
            </p>
          ) : (
            <div className="space-y-3">
              {results.map((r, i) => (
                <TransactionResultCard key={i} result={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
