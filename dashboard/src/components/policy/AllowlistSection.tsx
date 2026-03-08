"use client";

interface AllowlistValue {
  allowAddresses?: string[];
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
}

export default function AllowlistSection({
  value,
  onChange,
}: {
  value: AllowlistValue;
  onChange: (v: AllowlistValue) => void;
}) {
  function parseList(raw: string): string[] {
    return raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function toText(list?: string[]): string {
    return list?.join("\n") ?? "";
  }

  return (
    <div className="space-y-4">
      {(
        [
          ["allowAddresses", "Allowed Addresses"],
          ["denyAddresses", "Denied Addresses"],
          ["allowPrograms", "Allowed Programs"],
          ["denyPrograms", "Denied Programs"],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <label className="block text-sm text-text-secondary mb-1">
            {label}
          </label>
          <textarea
            value={toText(value[key])}
            onChange={(e) => {
              const list = parseList(e.target.value);
              onChange({
                ...value,
                [key]: list.length > 0 ? list : undefined,
              });
            }}
            placeholder="One address per line"
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
            rows={2}
          />
        </div>
      ))}
    </div>
  );
}
