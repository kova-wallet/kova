"use client";

interface RateLimitConfig {
  maxTransactionsPerMinute?: number;
  maxTransactionsPerHour?: number;
}

export default function RateLimitSection({
  value,
  onChange,
}: {
  value: RateLimitConfig;
  onChange: (v: RateLimitConfig) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-32">Per Minute</label>
        <input
          type="number"
          min={1}
          value={value.maxTransactionsPerMinute ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              maxTransactionsPerMinute: e.target.value
                ? parseInt(e.target.value, 10)
                : undefined,
            })
          }
          placeholder="e.g. 5"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-32">Per Hour</label>
        <input
          type="number"
          min={1}
          value={value.maxTransactionsPerHour ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              maxTransactionsPerHour: e.target.value
                ? parseInt(e.target.value, 10)
                : undefined,
            })
          }
          placeholder="e.g. 20"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>
    </div>
  );
}
