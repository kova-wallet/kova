/**
 * TimeWindowRule — Restricts when the agent can transact (active hours).
 *
 * Supports timezone-aware time windows with configurable behavior
 * outside active hours: deny or require approval.
 */

import type { PolicyRule, PolicyDecision, PolicyContext, ActiveHoursConfig } from "../types.js";
import type { TransactionIntent } from "../../core/intent.js";

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
    // LOW-04 note: When outsideHoursPolicy is "require_approval", this rule returns
    // DENY (not PENDING) because the TimeWindowRule itself does not handle approval
    // workflows. The approval flow is managed by the separate ApprovalGateRule which
    // returns PENDING and interacts with the ApprovalChannel. The DENY here with
    // a descriptive reason signals to the caller that approval is needed, and the
    // caller (or a wrapping rule) should initiate the approval flow. This naming
    // in the config ("require_approval") is potentially confusing since the rule
    // actually denies — consider renaming to "deny_with_approval_hint" in v2.
    //
    // LOW-T4-01 fix: Documentation clarification — "require_approval" is misleading.
    // Despite the name, this option behaves IDENTICALLY to "deny": both return a DENY
    // decision. The only difference is the reason string ("requires approval" vs
    // "denied"). TimeWindowRule has no integration with ApprovalChannel and cannot
    // return PENDING or initiate an approval workflow. To actually gate transactions
    // through human approval outside active hours, combine TimeWindowRule with a
    // separate ApprovalGateRule in the policy rule chain.
    //
    // @deprecated The "require_approval" option behaves identically to "deny" and may
    // be changed in a future version to actually gate through the approval system.
    // Until then, use "deny" for clarity, or pair with ApprovalGateRule for real
    // approval-gated behavior outside active hours.
    if (this.config.outsideHoursPolicy === "require_approval") {
      return {
        decision: "DENY",
        rule: this.name,
        reason: "Transaction requires approval outside active hours",
      };
    }

    return {
      decision: "DENY",
      rule: this.name,
      reason: `Transaction denied: outside active hours (timezone: ${this.config.timezone})`,
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
