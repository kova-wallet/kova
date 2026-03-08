"use client";

import { useState, useEffect, useCallback } from "react";

interface AuditEntry {
  status: string;
  summary: string;
  intentId: string;
  timestamp: number;
  txId?: string;
  error?: { code?: string; message?: string };
}

const statusColors: Record<string, string> = {
  confirmed: "bg-green-500/20 text-green-400",
  denied: "bg-red-500/20 text-red-400",
  failed: "bg-red-500/20 text-red-400",
  pending: "bg-yellow-500/20 text-yellow-400",
};

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const fetchLog = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/audit-log?${params}`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Audit Log</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search transactions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent w-64"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="denied">Denied</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
        <button
          onClick={fetchLog}
          className="bg-surface-hover text-text-secondary hover:text-text-primary px-3 py-2 rounded-md text-sm transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-text-secondary font-medium">Time</th>
              <th className="text-left px-4 py-3 text-text-secondary font-medium">Status</th>
              <th className="text-left px-4 py-3 text-text-secondary font-medium">Summary</th>
              <th className="text-left px-4 py-3 text-text-secondary font-medium">Intent ID</th>
              <th className="text-left px-4 py-3 text-text-secondary font-medium">Tx ID</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-text-secondary">
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-text-secondary">
                  No audit log entries found.
                </td>
              </tr>
            ) : (
              entries.map((entry, i) => (
                <tr key={`${entry.intentId}-${i}`} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3 text-text-secondary whitespace-nowrap font-mono text-xs">
                    {new Date(entry.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[entry.status] ?? "bg-surface-hover text-text-secondary"}`}>
                      {entry.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-primary max-w-xs truncate">
                    {entry.summary}
                    {entry.error?.message && (
                      <span className="block text-xs text-red-400 mt-0.5">{entry.error.message}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                    {entry.intentId.slice(0, 12)}...
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                    {entry.txId ? `${entry.txId.slice(0, 12)}...` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
