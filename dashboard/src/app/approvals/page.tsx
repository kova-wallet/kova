"use client";

import { useState, useEffect } from "react";
import ApprovalList from "@/components/approvals/ApprovalList";

export default function ApprovalsPage() {
  const [initialized, setInitialized] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => setInitialized(d.initialized));
  }, []);

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
        <h1 className="text-2xl font-bold mb-6">Approval Center</h1>
        <div className="bg-surface border border-border rounded-lg p-8 text-center">
          <p className="text-text-secondary mb-4">
            Create a wallet with an approval gate policy to use the approval center.
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
      <h1 className="text-2xl font-bold mb-6">Approval Center</h1>
      <ApprovalList />
    </div>
  );
}
