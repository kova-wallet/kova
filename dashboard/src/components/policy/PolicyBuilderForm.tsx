"use client";

import { useState, useEffect, useCallback } from "react";
import SpendingLimitSection from "./SpendingLimitSection";
import AllowlistSection from "./AllowlistSection";
import RateLimitSection from "./RateLimitSection";
import ActiveHoursSection from "./ActiveHoursSection";
import ApprovalGateSection from "./ApprovalGateSection";
import CooldownSection from "./CooldownSection";
import PolicyJsonPreview from "./PolicyJsonPreview";

interface PolicyConfig {
  name: string;
  spendingLimit?: {
    perTransaction?: { amount: string; token: string };
    daily?: { amount: string; token: string };
    weekly?: { amount: string; token: string };
    monthly?: { amount: string; token: string };
  };
  allowAddresses?: string[];
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
  rateLimit?: { maxTransactionsPerMinute?: number; maxTransactionsPerHour?: number };
  activeHours?: {
    timezone: string;
    windows: { days: ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[]; start: string; end: string }[];
  };
  approvalGate?: {
    above: { amount: string; token: string };
    timeout?: number;
    cumulativeWindow?: number;
  };
  cooldown?: {
    afterTransactionAbove: { amount: string; token: string };
    waitMinutes: number;
  };
}

interface SectionToggle {
  spendingLimit: boolean;
  allowlist: boolean;
  rateLimit: boolean;
  activeHours: boolean;
  approvalGate: boolean;
  cooldown: boolean;
}

const DEFAULT_TOGGLES: SectionToggle = {
  spendingLimit: true,
  allowlist: false,
  rateLimit: true,
  activeHours: false,
  approvalGate: false,
  cooldown: false,
};

export default function PolicyBuilderForm() {
  const [name, setName] = useState("custom-policy");
  const [toggles, setToggles] = useState<SectionToggle>(DEFAULT_TOGGLES);

  const [spendingLimit, setSpendingLimit] = useState<NonNullable<PolicyConfig["spendingLimit"]>>({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  });
  const [allowlist, setAllowlist] = useState<{
    allowAddresses?: string[];
    denyAddresses?: string[];
    allowPrograms?: string[];
    denyPrograms?: string[];
  }>({});
  const [rateLimit, setRateLimit] = useState<NonNullable<PolicyConfig["rateLimit"]>>({
    maxTransactionsPerMinute: 5,
  });
  const [activeHours, setActiveHours] = useState<NonNullable<PolicyConfig["activeHours"]>>({
    timezone: "UTC",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  });
  const [approvalGate, setApprovalGate] = useState<NonNullable<PolicyConfig["approvalGate"]>>({
    above: { amount: "1", token: "SOL" },
    timeout: 120_000,
  });
  const [cooldown, setCooldown] = useState<NonNullable<PolicyConfig["cooldown"]>>({
    afterTransactionAbove: { amount: "5", token: "SOL" },
    waitMinutes: 5,
  });

  const [valid, setValid] = useState<boolean | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const buildConfig = useCallback((): PolicyConfig => {
    const config: PolicyConfig = { name };

    if (toggles.spendingLimit) config.spendingLimit = spendingLimit;
    if (toggles.allowlist) {
      if (allowlist.allowAddresses?.length) config.allowAddresses = allowlist.allowAddresses;
      if (allowlist.denyAddresses?.length) config.denyAddresses = allowlist.denyAddresses;
      if (allowlist.allowPrograms?.length) config.allowPrograms = allowlist.allowPrograms;
      if (allowlist.denyPrograms?.length) config.denyPrograms = allowlist.denyPrograms;
    }
    if (toggles.rateLimit) config.rateLimit = rateLimit;
    if (toggles.activeHours) config.activeHours = activeHours;
    if (toggles.approvalGate) config.approvalGate = approvalGate;
    if (toggles.cooldown) config.cooldown = cooldown;

    return config;
  }, [name, toggles, spendingLimit, allowlist, rateLimit, activeHours, approvalGate, cooldown]);

  // Debounced validation
  useEffect(() => {
    const config = buildConfig();
    const hasRules = Object.keys(config).some((k) => k !== "name");
    if (!hasRules) {
      setValid(false);
      setValidationError("At least one rule must be enabled");
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/policy/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        const data = await res.json();
        setValid(data.valid);
        setValidationError(data.valid ? null : data.error);
      } catch {
        setValid(null);
        setValidationError(null);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [buildConfig]);

  async function handleApply() {
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await fetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildConfig()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setApplyResult("Policy applied successfully! Spending counters have been reset.");
    } catch (e) {
      setApplyResult(`Error: ${e instanceof Error ? e.message : "Failed to apply"}`);
    } finally {
      setApplying(false);
    }
  }

  function toggle(key: keyof SectionToggle) {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const sections: {
    key: keyof SectionToggle;
    label: string;
    description: string;
    component: React.ReactNode;
  }[] = [
    {
      key: "spendingLimit",
      label: "Spending Limits",
      description: "Cap per-transaction, daily, weekly, or monthly spend",
      component: <SpendingLimitSection value={spendingLimit} onChange={setSpendingLimit} />,
    },
    {
      key: "allowlist",
      label: "Address Allowlist",
      description: "Control which addresses and programs can be interacted with",
      component: <AllowlistSection value={allowlist} onChange={setAllowlist} />,
    },
    {
      key: "rateLimit",
      label: "Rate Limits",
      description: "Limit how many transactions can occur per minute/hour",
      component: <RateLimitSection value={rateLimit} onChange={setRateLimit} />,
    },
    {
      key: "activeHours",
      label: "Active Hours",
      description: "Restrict transactions to specific time windows",
      component: <ActiveHoursSection value={activeHours} onChange={setActiveHours} />,
    },
    {
      key: "approvalGate",
      label: "Approval Gate",
      description: "Require human approval for high-value transactions",
      component: <ApprovalGateSection value={approvalGate} onChange={setApprovalGate} />,
    },
    {
      key: "cooldown",
      label: "Cooldown",
      description: "Enforce a waiting period after large transactions",
      component: <CooldownSection value={cooldown} onChange={setCooldown} />,
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        {/* Policy name */}
        <div className="bg-surface border border-border rounded-lg p-4">
          <label className="block text-sm text-text-secondary mb-1">
            Policy Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>

        {/* Rule sections */}
        {sections.map(({ key, label, description, component }) => (
          <div key={key} className="bg-surface border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(key)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-hover transition-colors"
            >
              <div className="text-left">
                <span className="text-sm font-medium text-text-primary">{label}</span>
                <p className="text-xs text-text-secondary mt-0.5">{description}</p>
              </div>
              <div
                className={`w-10 h-5 rounded-full transition-colors ${
                  toggles[key] ? "bg-accent" : "bg-border"
                } relative`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform ${
                    toggles[key] ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </div>
            </button>
            {toggles[key] && <div className="px-4 pb-4 pt-2">{component}</div>}
          </div>
        ))}

        {/* Apply button */}
        <button
          onClick={handleApply}
          disabled={applying || valid === false}
          className="w-full bg-accent hover:bg-accent-hover text-white py-2.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
        >
          {applying ? "Applying..." : "Apply Policy"}
        </button>

        {applyResult && (
          <p
            className={`text-sm ${
              applyResult.startsWith("Error") ? "text-danger" : "text-success"
            }`}
          >
            {applyResult}
          </p>
        )}

        <p className="text-xs text-text-secondary">
          Applying a new policy resets spending counters and rate limits. The wallet
          address and balance are preserved.
        </p>
      </div>

      {/* JSON Preview */}
      <div className="lg:sticky lg:top-8 lg:self-start">
        <PolicyJsonPreview
          config={buildConfig() as unknown as Record<string, unknown>}
          valid={valid}
          error={validationError}
        />
      </div>
    </div>
  );
}
