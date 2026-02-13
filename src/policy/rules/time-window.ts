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

  /** Check if the given time falls within any configured active window */
  private isWithinActiveHours(now: Date): boolean {
    // Get current time in the configured timezone
    let currentDay: string;
    let currentMinutes: number;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: this.config.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const weekday = parts.find(p => p.type === "weekday")?.value?.toLowerCase() ?? "";
      const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
      const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);

      currentDay = this.normalizeDayName(weekday);
      currentMinutes = hour * 60 + minute;
    } catch {
      // If timezone is invalid, fail closed (deny)
      return false;
    }

    for (const window of this.config.windows) {
      // Check if current day is in the window's days
      if (!window.days.includes(currentDay as typeof window.days[number])) {
        continue;
      }

      // Parse start and end times to minutes since midnight
      const startMinutes = this.parseTimeToMinutes(window.start);
      const endMinutes = this.parseTimeToMinutes(window.end);

      if (startMinutes <= endMinutes) {
        // Normal range: e.g., 09:00 to 17:00
        if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
          return true;
        }
      } else {
        // Overnight range: e.g., 22:00 to 06:00
        if (currentMinutes >= startMinutes || currentMinutes < endMinutes) {
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
}
