"use client";

import { useState, useEffect, useCallback } from "react";
import PolicyBuilderForm from "@/components/policy/PolicyBuilderForm";
import PolicyTemplatePicker from "@/components/policy/PolicyTemplatePicker";

export default function PolicyPage() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((d) => setInitialized(d.initialized));
  }, []);

  const handleTemplateApplied = useCallback(() => {
    setRefreshKey((k) => k + 1);
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
        <h1 className="text-2xl font-bold mb-6">Policy Builder</h1>
        <div className="bg-surface border border-border rounded-lg p-8 text-center">
          <p className="text-text-secondary mb-4">
            Create a wallet first to configure its policy.
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
      <h1 className="text-2xl font-bold mb-6">Policy Builder</h1>
      <PolicyTemplatePicker onApply={handleTemplateApplied} />
      <PolicyBuilderForm key={refreshKey} />
    </div>
  );
}
