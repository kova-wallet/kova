"use client";

interface ApprovalGateConfig {
  above: { amount: string; token: string };
  timeout?: number;
  cumulativeWindow?: number;
}

export default function ApprovalGateSection({
  value,
  onChange,
}: {
  value: ApprovalGateConfig;
  onChange: (v: ApprovalGateConfig) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-40">
          Require approval above
        </label>
        <input
          type="text"
          value={value.above.amount}
          onChange={(e) =>
            onChange({
              ...value,
              above: { ...value.above, amount: e.target.value },
            })
          }
          placeholder="e.g. 1"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
        <span className="text-sm text-text-secondary">SOL</span>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-40">
          Timeout (seconds)
        </label>
        <input
          type="number"
          min={10}
          value={value.timeout ? value.timeout / 1000 : ""}
          onChange={(e) =>
            onChange({
              ...value,
              timeout: e.target.value
                ? parseInt(e.target.value, 10) * 1000
                : undefined,
            })
          }
          placeholder="120"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-40">
          Cumulative window (sec)
        </label>
        <input
          type="number"
          min={0}
          value={value.cumulativeWindow ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              cumulativeWindow: e.target.value
                ? parseInt(e.target.value, 10)
                : undefined,
            })
          }
          placeholder="3600"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>
      <p className="text-xs text-text-secondary">
        Cumulative window prevents fragmentation attacks by tracking total spend
        over a rolling window.
      </p>
    </div>
  );
}
