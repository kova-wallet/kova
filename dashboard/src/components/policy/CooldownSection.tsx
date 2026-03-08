"use client";

interface CooldownConfig {
  afterTransactionAbove: { amount: string; token: string };
  waitMinutes: number;
}

export default function CooldownSection({
  value,
  onChange,
}: {
  value: CooldownConfig;
  onChange: (v: CooldownConfig) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-40">
          After tx above
        </label>
        <input
          type="text"
          value={value.afterTransactionAbove.amount}
          onChange={(e) =>
            onChange({
              ...value,
              afterTransactionAbove: {
                ...value.afterTransactionAbove,
                amount: e.target.value,
              },
            })
          }
          placeholder="e.g. 5"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
        <span className="text-sm text-text-secondary">SOL</span>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-40">Wait (minutes)</label>
        <input
          type="number"
          min={1}
          value={value.waitMinutes || ""}
          onChange={(e) =>
            onChange({
              ...value,
              waitMinutes: parseInt(e.target.value, 10) || 0,
            })
          }
          placeholder="5"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>
    </div>
  );
}
