"use client";

import { useState, useEffect } from "react";

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
}

const categoryColors: Record<string, string> = {
  conservative: "bg-green-500/20 text-green-400",
  moderate: "bg-blue-500/20 text-blue-400",
  defi: "bg-purple-500/20 text-purple-400",
  testing: "bg-yellow-500/20 text-yellow-400",
};

export default function PolicyTemplatePicker({
  onApply,
}: {
  onApply: () => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/policy/templates")
      .then((r) => r.json())
      .then((data) => setTemplates(data.templates ?? []))
      .catch(() => {});
  }, []);

  async function handleApply(templateId: string) {
    setLoading(templateId);
    setError(null);
    try {
      // Get the built config from the template
      const buildRes = await fetch("/api/policy/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const { config, error: buildError } = await buildRes.json();
      if (!buildRes.ok) throw new Error(buildError);

      // Apply the config
      const applyRes = await fetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!applyRes.ok) {
        const data = await applyRes.json();
        throw new Error(data.error);
      }

      onApply();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply template");
    } finally {
      setLoading(null);
    }
  }

  if (templates.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider mb-3">
        Quick Start Templates
      </h3>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => handleApply(t.id)}
            disabled={loading !== null}
            className="bg-surface border border-border rounded-lg p-4 text-left hover:border-accent/50 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-sm text-text-primary">{t.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${categoryColors[t.category] ?? "bg-surface-hover text-text-secondary"}`}>
                {t.category}
              </span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">{t.description}</p>
            {loading === t.id && (
              <p className="text-xs text-accent mt-2">Applying...</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
