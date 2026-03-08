/**
 * Audit log helpers — reads transaction history from the active wallet's store
 * and provides filtering/search capabilities for the audit log viewer.
 */

import { getWallet } from "./wallet-manager";

export interface AuditEntry {
  status: string;
  summary: string;
  intentId: string;
  timestamp: number;
  txId?: string;
  error?: { code?: string; message?: string };
}

export interface AuditLogQuery {
  limit?: number;
  status?: string;
  search?: string;
  after?: number;   // timestamp filter: entries after this time
  before?: number;  // timestamp filter: entries before this time
}

/**
 * Fetch and filter audit log entries from the active wallet.
 */
export async function queryAuditLog(query: AuditLogQuery = {}): Promise<AuditEntry[]> {
  const wallet = getWallet();
  if (!wallet) return [];

  const limit = Math.min(query.limit ?? 100, 500);

  // Fetch more than requested to account for filtering
  const fetchLimit = query.status || query.search || query.after || query.before
    ? Math.min(limit * 3, 500)
    : limit;

  const history = await wallet.getTransactionHistory(fetchLimit);

  let entries: AuditEntry[] = history.map((tx) => ({
    status: tx.status,
    summary: tx.summary,
    intentId: tx.intentId,
    timestamp: tx.timestamp,
    txId: "txId" in tx ? tx.txId : undefined,
    error: "error" in tx && tx.error ? { code: tx.error.code, message: tx.error.message } : undefined,
  }));

  // Apply filters
  if (query.status) {
    entries = entries.filter((e) => e.status === query.status);
  }
  if (query.search) {
    const term = query.search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.summary.toLowerCase().includes(term) ||
        e.intentId.toLowerCase().includes(term) ||
        (e.txId && e.txId.toLowerCase().includes(term))
    );
  }
  if (query.after) {
    entries = entries.filter((e) => e.timestamp > query.after!);
  }
  if (query.before) {
    entries = entries.filter((e) => e.timestamp < query.before!);
  }

  return entries.slice(0, limit);
}
