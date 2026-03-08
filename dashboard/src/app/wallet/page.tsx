"use client";

import { useState, useEffect, useCallback } from "react";
import CreateWalletForm from "@/components/wallet/CreateWalletForm";
import AirdropButton from "@/components/wallet/AirdropButton";

export default function WalletPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [networkLabel, setNetworkLabel] = useState("...");
  const [signerType, setSignerType] = useState<string | null>(null);
  const [walletCount, setWalletCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet");
      const data = await res.json();
      if (data.initialized) {
        setAddress(data.address);
        setNetworkLabel(data.networkLabel ?? "...");
        setSignerType(data.signerType ?? null);
        setWalletCount(data.loadedWallets?.length ?? 0);
        fetchBalance();
      }
    } finally {
      setLoading(false);
    }
  }, []);

  async function fetchBalance() {
    try {
      const res = await fetch("/api/wallet/balance?token=SOL");
      if (res.ok) {
        const data = await res.json();
        setBalance(data.amount);
      }
    } catch {
      // Non-fatal
    }
  }

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleDestroy() {
    if (!confirm("Destroy this wallet? All state will be lost.")) return;
    await fetch("/api/wallet/destroy", { method: "POST" });
    // Reload — may switch to another loaded wallet
    setLoading(true);
    setAddress(null);
    setBalance(null);
    fetchStatus();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!address) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Wallet Setup</h1>
        <CreateWalletForm
          onCreated={(addr) => {
            setAddress(addr);
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Wallet</h1>

      <div className="bg-surface border border-border rounded-lg p-6 max-w-lg mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
            Wallet Address
          </h2>
          <div className="flex gap-2">
            {signerType && (
              <span className="bg-accent/20 text-accent text-xs px-2 py-0.5 rounded-full capitalize">
                {signerType}
              </span>
            )}
            <span className="bg-blue-500/20 text-blue-400 text-xs px-2 py-0.5 rounded-full">
              {networkLabel}
            </span>
          </div>
        </div>
        <p className="font-mono text-sm text-text-primary break-all mb-4">
          {address}
        </p>
        <button
          onClick={() => navigator.clipboard.writeText(address)}
          className="text-xs text-accent hover:text-accent-hover transition-colors"
        >
          Copy address
        </button>
      </div>

      <div className="bg-surface border border-border rounded-lg p-6 max-w-lg mb-6">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
          Balance
        </h2>
        <p className="text-3xl font-bold">
          {balance ?? "—"}{" "}
          <span className="text-lg text-text-secondary">SOL</span>
        </p>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        <AirdropButton onSuccess={fetchBalance} />
        <button
          onClick={handleDestroy}
          className="bg-danger/20 text-danger hover:bg-danger/30 px-4 py-2 rounded-md text-sm font-medium transition-colors"
        >
          Destroy Wallet
        </button>
      </div>

      {walletCount > 0 && (
        <p className="text-xs text-text-secondary mt-4">
          {walletCount} wallet{walletCount !== 1 ? "s" : ""} loaded. Use the sidebar to switch between wallets.
        </p>
      )}
    </div>
  );
}
