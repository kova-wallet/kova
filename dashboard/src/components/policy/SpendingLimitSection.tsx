"use client";

interface SpendingLimitConfig {
  perTransaction?: { amount: string; token: string };
  daily?: { amount: string; token: string };
  weekly?: { amount: string; token: string };
  monthly?: { amount: string; token: string };
}

export default function SpendingLimitSection({
  value,
  onChange,
}: {
  value: SpendingLimitConfig;
  onChange: (v: SpendingLimitConfig) => void;
}) {
  function updateField(
    field: keyof SpendingLimitConfig,
    amount: string
  ) {
    if (!amount) {
      const next = { ...value };
      delete next[field];
      onChange(next);
    } else {
      onChange({ ...value, [field]: { amount, token: "SOL" } });
    }
  }

  return (
    <div className="space-y-3">
      {(
        [
          ["perTransaction", "Per Transaction"],
          ["daily", "Daily"],
          ["weekly", "Weekly"],
          ["monthly", "Monthly"],
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="flex items-center gap-3">
          <label className="text-sm text-text-secondary w-32">{label}</label>
          <input
            type="text"
            value={value[key]?.amount ?? ""}
            onChange={(e) => updateField(key, e.target.value)}
            placeholder="e.g. 10"
            className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
          />
          <span className="text-sm text-text-secondary">SOL</span>
        </div>
      ))}
    </div>
  );
}
