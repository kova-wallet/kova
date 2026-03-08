/**
 * Alert system — fires webhooks when policy-relevant events occur.
 *
 * Events:
 *   - transaction_denied: A transaction was denied by policy
 *   - spending_limit_warning: Spending approaches configured threshold
 *   - circuit_breaker_tripped: Circuit breaker activated
 *
 * Alerts are dispatched via webhooks configured in environment variables.
 * Multiple webhook URLs can be configured (comma-separated).
 */

export type AlertLevel = "info" | "warning" | "critical";

export interface AlertEvent {
  type: string;
  level: AlertLevel;
  message: string;
  walletAddress: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

// In-memory alert history for dashboard display
const ALERT_HISTORY_KEY = "__kova_alert_history__" as const;
const MAX_ALERT_HISTORY = 200;

function getAlertHistory(): AlertEvent[] {
  const g = globalThis as unknown as Record<string, AlertEvent[]>;
  if (!g[ALERT_HISTORY_KEY]) {
    g[ALERT_HISTORY_KEY] = [];
  }
  return g[ALERT_HISTORY_KEY];
}

/**
 * Get configured webhook URLs from environment.
 */
function getWebhookUrls(): string[] {
  const raw = process.env.KOVA_ALERT_WEBHOOKS;
  if (!raw) return [];
  return raw.split(",").map((u) => u.trim()).filter(Boolean);
}

/**
 * Fire an alert — stores in memory and dispatches to webhooks.
 */
export async function fireAlert(event: AlertEvent): Promise<void> {
  // Store in memory
  const history = getAlertHistory();
  history.unshift(event);
  if (history.length > MAX_ALERT_HISTORY) {
    history.length = MAX_ALERT_HISTORY;
  }

  // Dispatch to webhooks (fire-and-forget)
  const urls = getWebhookUrls();
  for (const url of urls) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }).catch((err) => {
      console.error(`[kova] Alert webhook failed (${url}):`, err);
    });
  }

  // Console logging for all alerts
  const prefix = event.level === "critical" ? "CRITICAL" : event.level === "warning" ? "WARNING" : "INFO";
  console.log(`[kova-alert] [${prefix}] ${event.type}: ${event.message}`);
}

/**
 * Get recent alerts for dashboard display.
 */
export function getRecentAlerts(limit = 50): AlertEvent[] {
  return getAlertHistory().slice(0, limit);
}

/**
 * Clear alert history.
 */
export function clearAlerts(): void {
  const g = globalThis as unknown as Record<string, AlertEvent[]>;
  g[ALERT_HISTORY_KEY] = [];
}

// ── Convenience alert creators ─────────────────────────────────────────────

export function alertTransactionDenied(
  walletAddress: string,
  reason: string,
  intentId: string
): Promise<void> {
  return fireAlert({
    type: "transaction_denied",
    level: "warning",
    message: `Transaction denied: ${reason}`,
    walletAddress,
    timestamp: Date.now(),
    details: { intentId, reason },
  });
}

export function alertSpendingLimitWarning(
  walletAddress: string,
  token: string,
  spent: string,
  limit: string,
  window: string
): Promise<void> {
  return fireAlert({
    type: "spending_limit_warning",
    level: "warning",
    message: `Spending limit warning: ${spent}/${limit} ${token} used in ${window} window`,
    walletAddress,
    timestamp: Date.now(),
    details: { token, spent, limit, window },
  });
}

export function alertCircuitBreakerTripped(
  walletAddress: string,
  reason: string
): Promise<void> {
  return fireAlert({
    type: "circuit_breaker_tripped",
    level: "critical",
    message: `Circuit breaker tripped: ${reason}`,
    walletAddress,
    timestamp: Date.now(),
    details: { reason },
  });
}
