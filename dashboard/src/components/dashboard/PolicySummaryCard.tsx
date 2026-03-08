"use client";

import { usePolling } from "@/hooks/usePolling";

interface PolicyConfig {
  name: string;
  spendingLimit?: {
    perTransaction?: { amount: string; token: string };
    daily?: { amount: string; token: string };
    weekly?: { amount: string; token: string };
    monthly?: { amount: string; token: string };
  };
  allowAddresses?: string[];
  allowPrograms?: string[];
  rateLimit?: { maxTransactionsPerMinute?: number; maxTransactionsPerHour?: number };
  approvalGate?: { above: { amount: string; token: string } };
  activeHours?: {
    timezone: string;
    windows: { days: string[]; start: string; end: string }[];
  };
  cooldown?: {
    afterTransactionAbove: { amount: string; token: string };
    waitMinutes: number;
  };
}

interface PolicyData {
  config: PolicyConfig;
  summary: { circuitBreaker?: { threshold: number; isOpen: boolean } };
}

export default function PolicySummaryCard() {
  const { data, loading } = usePolling<PolicyData>("/api/policy", 30_000);

  if (loading && !data) {
    return (
      <div className="bg-surface border border-border rounded-lg p-6">
        <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
          Active Policy
        </h3>
        <div className="space-y-2">
          <div className="h-4 w-40 bg-surface-hover rounded animate-pulse" />
          <div className="h-4 w-32 bg-surface-hover rounded animate-pulse" />
        </div>
      </div>
    );
  }

  const c = data?.config;
  const cb = data?.summary?.circuitBreaker;

  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
        Active Policy
      </h3>
      {c ? (
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-text-secondary">Name:</span>{" "}
            <span className="font-medium">{c.name}</span>
          </p>
          {c.spendingLimit && (
            <div>
              <span className="text-text-secondary">Spending limits:</span>
              <ul className="ml-4 mt-1 space-y-0.5 text-xs">
                {c.spendingLimit.perTransaction && (
                  <li>Per tx: <span className="text-warning font-medium">{c.spendingLimit.perTransaction.amount} {c.spendingLimit.perTransaction.token}</span></li>
                )}
                {c.spendingLimit.daily && (
                  <li>Daily: <span className="text-warning font-medium">{c.spendingLimit.daily.amount} {c.spendingLimit.daily.token}</span></li>
                )}
                {c.spendingLimit.weekly && (
                  <li>Weekly: <span className="text-warning font-medium">{c.spendingLimit.weekly.amount} {c.spendingLimit.weekly.token}</span></li>
                )}
                {c.spendingLimit.monthly && (
                  <li>Monthly: <span className="text-warning font-medium">{c.spendingLimit.monthly.amount} {c.spendingLimit.monthly.token}</span></li>
                )}
              </ul>
            </div>
          )}
          {(c.allowAddresses?.length ?? 0) > 0 && (
            <p>
              <span className="text-text-secondary">Allowlisted addresses:</span>{" "}
              {c.allowAddresses!.length}
            </p>
          )}
          {(c.allowPrograms?.length ?? 0) > 0 && (
            <p>
              <span className="text-text-secondary">Allowlisted programs:</span>{" "}
              {c.allowPrograms!.length}
            </p>
          )}
          {c.rateLimit && (
            <p>
              <span className="text-text-secondary">Rate limits:</span>{" "}
              {c.rateLimit.maxTransactionsPerMinute && `${c.rateLimit.maxTransactionsPerMinute}/min`}
              {c.rateLimit.maxTransactionsPerMinute && c.rateLimit.maxTransactionsPerHour && ", "}
              {c.rateLimit.maxTransactionsPerHour && `${c.rateLimit.maxTransactionsPerHour}/hr`}
            </p>
          )}
          {c.approvalGate && (
            <p>
              <span className="text-text-secondary">Approval above:</span>{" "}
              <span className="text-accent">
                {c.approvalGate.above.amount} {c.approvalGate.above.token}
              </span>
            </p>
          )}
          {c.activeHours && (
            <p>
              <span className="text-text-secondary">Active hours:</span>{" "}
              {c.activeHours.windows.map((w, i) => (
                <span key={i} className="text-xs">
                  {w.days.join(",")} {w.start}-{w.end}{" "}
                </span>
              ))}
              <span className="text-xs text-text-secondary">({c.activeHours.timezone})</span>
            </p>
          )}
          {c.cooldown && (
            <p>
              <span className="text-text-secondary">Cooldown:</span>{" "}
              {c.cooldown.waitMinutes}min after {c.cooldown.afterTransactionAbove.amount} {c.cooldown.afterTransactionAbove.token}
            </p>
          )}
          {cb && (
            <p>
              <span className="text-text-secondary">Circuit breaker:</span>{" "}
              <span className={cb.isOpen ? "text-danger" : "text-success"}>
                {cb.isOpen ? "OPEN" : "Closed"}
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="text-text-secondary text-sm">No policy configured</p>
      )}
    </div>
  );
}
