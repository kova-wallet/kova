"use client";

export default function PolicyJsonPreview({
  config,
  valid,
  error,
}: {
  config: Record<string, unknown>;
  valid: boolean | null;
  error: string | null;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Policy JSON
        </h3>
        {valid !== null && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              valid
                ? "bg-success/20 text-success"
                : "bg-danger/20 text-danger"
            }`}
          >
            {valid ? "Valid" : "Invalid"}
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-danger mb-2">{error}</p>
      )}
      <pre className="bg-background rounded-md p-3 text-xs font-mono text-text-primary overflow-auto max-h-96">
        {JSON.stringify(config, null, 2)}
      </pre>
    </div>
  );
}
