/**
 * TimeWindowRule — Restricts when the agent can transact (active hours).
 *
 * Supports timezone-aware time windows with configurable behavior
 * outside active hours: deny or require approval.
 */

import { createHash } from "node:crypto";
import type { PolicyRule, PolicyDecision, PolicyContext, ActiveHoursConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";

/**
 * HIGH-09 fix: Canonical JSON serialization with sorted keys for deterministic hashing.
 * This ensures the intent hash is consistent regardless of property insertion order.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const sortedKeys = Object.keys(obj).filter((k) => !DANGEROUS_KEYS.has(k)).sort();
  const entries = sortedKeys.map(
    (key) => JSON.stringify(key) + ":" + canonicalJsonStringify(obj[key]),
  );
  return "{" + entries.join(",") + "}";
}

/**
 * HIGH-09 fix: Compute a SHA-256 hash of the intent parameters.
 * Cryptographically binds the TimeWindowRule approval to the exact transaction,
 * preventing TOCTOU modification of the intent after approval.
 */
function computeIntentHash(intent: TransactionIntent): string {
  const payload = canonicalJsonStringify({
    type: intent.type,
    chain: intent.chain,
    params: intent.params,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * HIGH-09 fix: Extract a human-readable amount and token from the intent params.
 * Used to populate approval request fields with actual transaction data instead
 * of generic "N/A" placeholders.
 */
function extractAmountAndToken(intent: TransactionIntent): { amount: string; token: string; target: string } {
  const params = intent.params as unknown as Record<string, unknown>;
  const amount = typeof params.amount === "string" ? params.amount : "N/A";
  const token = typeof params.token === "string"
    ? params.token
    : typeof params.fromToken === "string"
      ? params.fromToken
      : "N/A";
  const target = typeof params.to === "string"
    ? params.to
    : typeof params.programId === "string"
      ? params.programId
      : "N/A";
  return { amount, token, target };
}

/** Map day-of-week number (0=Sun) to config day string */
export class TimeWindowRule implements PolicyRule {
  readonly name = "time-window";
  private readonly config: ActiveHoursConfig;

  constructor(config: ActiveHoursConfig) {
    // HIGH-T4-03 fix: Validate timezone at construction time using Intl.DateTimeFormat.
    // An invalid timezone would silently fail-closed at evaluation time (isWithinActiveHours
    // catches errors and returns false), but failing at construction is preferable because
    // it surfaces misconfiguration immediately rather than silently denying all transactions.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
    } catch {
      throw new Error(
        `TimeWindowRule: invalid timezone "${config.timezone}". ` +
        `Use a valid IANA timezone identifier (e.g., "America/New_York", "UTC").`,
      );
    }

    // MED-31 fix: Validate each window's start/end times at construction time.
    // parseTimeToMinutes can produce NaN or out-of-range values for malformed
    // time strings, which would cause isWithinActiveHours to silently malfunction.
    if (config.windows) {
      for (const window of config.windows) {
        const startMinutes = this.parseTimeToMinutes(window.start);
        const endMinutes = this.parseTimeToMinutes(window.end);
        if (!Number.isFinite(startMinutes) || startMinutes < 0 || startMinutes > 1439) {
          throw new Error(
            `TimeWindowRule: invalid start time "${window.start}" — ` +
            `parsed to ${startMinutes} minutes, must be in range [0, 1439]`,
          );
        }
        if (!Number.isFinite(endMinutes) || endMinutes < 0 || endMinutes > 1439) {
          throw new Error(
            `TimeWindowRule: invalid end time "${window.end}" — ` +
            `parsed to ${endMinutes} minutes, must be in range [0, 1439]`,
          );
        }
      }
    }
    this.config = config;
  }

  /** Get the active hours configuration (for policy introspection) */
  getConfig(): Readonly<ActiveHoursConfig> {
    return this.config;
  }

  async evaluate(_intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
    const now = new Date(context.now);
    const isActive = this.isWithinActiveHours(now);

    if (isActive) {
      return { decision: "ALLOW" };
    }

    // Outside active hours
    // MED-T3-02 fix: When outsideHoursPolicy is "require_approval", actually request
    // human approval through the approval channel if one is available. Previously,
    // this option behaved identically to "deny", which was misleading. Now it properly
    // integrates with the ApprovalChannel to gate transactions outside active hours.
    if (this.config.outsideHoursPolicy === "require_approval") {
      if (context.approval) {
        // HIGH-09 fix: Compute intent hash BEFORE sending the approval request
        // to cryptographically bind the approval to the exact transaction parameters.
        const intentHash = computeIntentHash(_intent);
        const { amount: txAmount, token: txToken, target: txTarget } = extractAmountAndToken(_intent);
        try {
          const result = await context.approval.requestApproval({
            id: crypto.randomUUID(),
            summary: `${_intent.type} transaction outside active hours`,
            amount: txAmount,
            token: txToken,
            target: txTarget,
            reason: "Transaction attempted outside active hours — requires manual approval",
            agentId: _intent.metadata?.agentId,
            expiresAt: context.now + 300_000, // 5 minute timeout
            // HIGH-09 fix: Bind approval to the exact intent parameters
            intentHash,
          });
          if (result.decision === "approved") {
            // HIGH-09 fix: Re-compute the intent hash and verify it hasn't changed
            // since the approval was requested (TOCTOU defense-in-depth).
            const recomputedHash = computeIntentHash(_intent);
            if (recomputedHash !== intentHash) {
              return {
                decision: "DENY",
                rule: this.name,
                reason: `Approval intent hash mismatch: the transaction was modified after approval was requested. ` +
                  `Original ${intentHash.slice(0, 16)}..., re-computed ${recomputedHash.slice(0, 16)}...`,
              };
            }
            return { decision: "ALLOW" };
          }
          return {
            decision: "DENY",
            rule: this.name,
            reason: `Transaction outside active hours was ${result.decision === "timeout" ? "not approved in time" : "rejected by approver"}`,
          };
        } catch {
          // Fail-closed on approval channel errors
          return {
            decision: "DENY",
            rule: this.name,
            reason: "Transaction outside active hours: approval channel error",
          };
        }
      }
      // No approval channel available — fall through to DENY
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Transaction requires approval outside active hours, but no approval channel is configured",
      };
    }

    return {
      decision: "DENY",
      rule: this.name,
      // POLICY-011 fix: Generic denial message without timezone details to prevent
      // information disclosure about operator location/operational hours.
      reason: "Transaction denied: outside active hours",
    };
  }

  /**
   * Check if the given time falls within any configured active window.
   *
   * L-02 DST EDGE CASE DOCUMENTATION:
   * This method uses Intl.DateTimeFormat to convert UTC time to the configured timezone,
   * which correctly handles DST transitions. However, the time window enforcement has
   * inherent DST edge cases:
   *
   * - Spring-forward (e.g., 2:00 AM -> 3:00 AM): If an active window includes the
   *   skipped hour (e.g., 01:00-04:00), agents effectively get one fewer hour of
   *   access because 2:00-3:00 AM doesn't exist in local time. This is the SAFE
   *   direction (less access, not more).
   *
   * - Fall-back (e.g., 2:00 AM -> 1:00 AM): If an active window includes the
   *   repeated hour (e.g., 01:00-04:00), agents get one extra hour of access because
   *   1:00-2:00 AM occurs twice. This grants ADDITIONAL access beyond the intended
   *   window, but only for one hour per DST transition (typically twice per year).
   *
   * POLICY-015 SECURITY NOTE: The DST fall-back issue means an agent could execute
   * transactions during an unintended extra hour window. For high-security deployments
   * where time-window precision is critical (e.g., trading bots with strict market-hours
   * constraints), use UTC timezone to eliminate DST ambiguity entirely. The risk is LOW
   * because it only affects 1 hour, at most twice per year, and only when the active
   * window overlaps with the DST transition hour.
   *
   * For stricter control that eliminates DST edge cases entirely, configure the
   * timezone to "UTC" and compute your desired local windows as UTC offsets. This
   * avoids all DST ambiguity at the cost of requiring manual adjustment when DST
   * rules change.
   */
  private isWithinActiveHours(now: Date): boolean {
    // Get current time in the configured timezone
    let currentDay: string;
    let currentMinutes: number;

    try {
      // POLICY-016: DateTimeFormat options are consistent — this is the only place
      // DateTimeFormat is used. The "en-US" locale with explicit hour12:false ensures
      // 24-hour format. Note: hour:"numeric" with hour12:false may return "24" for
      // midnight in some ICU implementations (instead of "0"). The modulo below
      // normalizes this to 0 for correctness.
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: this.config.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const weekday = parts.find(p => p.type === "weekday")?.value?.toLowerCase() ?? "";
      // POLICY-016: Modulo 24 normalizes "24" (returned by some ICU implementations for
      // midnight with hour12:false) to 0, ensuring correct minute-of-day calculation.
      const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10) % 24;
      const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);

      currentDay = this.normalizeDayName(weekday);
      currentMinutes = hour * 60 + minute;
    } catch {
      // If timezone is invalid, fail closed (deny)
      return false;
    }

    for (const window of this.config.windows) {
      // Parse start and end times to minutes since midnight
      const startMinutes = this.parseTimeToMinutes(window.start);
      const endMinutes = this.parseTimeToMinutes(window.end);

      if (startMinutes <= endMinutes) {
        // Normal range: e.g., 09:00 to 17:00
        // The current day must be in the window's days list.
        if (!window.days.includes(currentDay as typeof window.days[number])) {
          continue;
        }
        if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
          return true;
        }
      } else {
        // POLICY-004 fix (RESOLVED): Overnight range (e.g., 22:00 to 06:00) spans two calendar days.
        // The evening portion (>= startMinutes) belongs to the configured day, but the
        // morning portion (< endMinutes) belongs to the NEXT calendar day. For example,
        // a window of 22:00-06:00 on "mon" should be active from Monday 22:00 to Tuesday 06:00.
        // We must check: if we're in the evening portion, the current day should be in the
        // window's days; if we're in the morning portion, the PREVIOUS day should be in
        // the window's days (because the window started the previous evening).
        if (currentMinutes >= startMinutes) {
          // Evening portion — current day must be in the configured days
          if (!window.days.includes(currentDay as typeof window.days[number])) {
            continue;
          }
          return true;
        } else if (currentMinutes < endMinutes) {
          // Morning portion — the PREVIOUS day must be in the configured days,
          // because this window started the previous evening
          const previousDay = this.getPreviousDay(currentDay);
          if (!window.days.includes(previousDay as typeof window.days[number])) {
            continue;
          }
          return true;
        }
      }
    }

    return false;
  }

  /** Parse "HH:MM" to minutes since midnight */
  private parseTimeToMinutes(time: string): number {
    const [hours, minutes] = time.split(":").map(Number);
    return hours! * 60 + minutes!;
  }

  /** Normalize 3-letter day abbreviation to our config format */
  private normalizeDayName(day: string): string {
    const mapping: Record<string, string> = {
      sun: "sun", mon: "mon", tue: "tue", wed: "wed",
      thu: "thu", fri: "fri", sat: "sat",
    };
    return mapping[day.slice(0, 3)] ?? day;
  }

  /** POLICY-004 fix: Get the previous day of the week (e.g., "tue" -> "mon", "sun" -> "sat") */
  private getPreviousDay(day: string): string {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const index = days.indexOf(day);
    return days[(index - 1 + 7) % 7]!;
  }
}
