/**
 * Rule-based, explainable project health-status engine.
 *
 * This is deliberately NOT machine-learned or opaque: a project is
 * classified as `on_track` | `at_risk` | `delayed` purely from a small set
 * of named, fixed thresholds applied to numbers the caller has already
 * computed (see analytics/analytics.service.ts). Every classification
 * carries a human-readable explanation built dynamically from those same
 * numbers — never a canned template with no data behind it.
 *
 * The thresholds below are a defensible v1 default, not tuned against real
 * usage data (there isn't any yet). They live in this one file, isolated
 * from the rest of analytics, specifically so they're easy to find and
 * adjust later without touching the metric-computation code around them.
 */

export type HealthStatus = "on_track" | "at_risk" | "delayed";

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  on_track: "On Track",
  at_risk: "At Risk",
  delayed: "Delayed",
};

// ---------------------------------------------------------------------------
// Thresholds (the "rules" — deliberately named constants, not magic numbers)
// ---------------------------------------------------------------------------

/** delayed: more than this % of a project's OPEN tasks are overdue. */
export const DELAYED_OVERDUE_PERCENT_THRESHOLD = 40;
/** at_risk: more than this % of a project's OPEN tasks are overdue. */
export const AT_RISK_OVERDUE_PERCENT_THRESHOLD = 20;

/**
 * delayed: any high/urgent-priority task has been continuously blocked by
 * an incomplete dependency for more than this many days. "Blocked since" is
 * approximated as the TaskDependency edge's `createdAt` (the codebase has
 * no dedicated "became blocked at" timestamp) — a documented judgment call.
 */
export const DELAYED_BLOCKED_DAYS_THRESHOLD = 7;

/**
 * at_risk: at least this many high/urgent-priority tasks are currently
 * blocked (regardless of how long). Any single URGENT task being blocked
 * also trips at_risk immediately, independent of this count — see
 * `hasUrgentBlockedTask` below.
 */
export const AT_RISK_BLOCKED_HIGH_OR_URGENT_COUNT_THRESHOLD = 2;

/**
 * at_risk: milestone completion is this many percentage points (or more)
 * behind how far the project's own timeline (startDate -> targetDate) has
 * already elapsed.
 */
export const AT_RISK_MILESTONE_GAP_POINTS_THRESHOLD = 20;

export interface HealthStatusInput {
  /** Tasks not in a `done`-category column. */
  openTaskCount: number;
  /** Of the open tasks, how many have a past-due `dueDate`. */
  overdueOpenTaskCount: number;
  /** Open, high-or-urgent-priority tasks currently blocked by an incomplete dependency. */
  blockedHighOrUrgentTaskCount: number;
  /** True if at least one currently-blocked open task is URGENT priority. */
  hasUrgentBlockedTask: boolean;
  /** Longest continuous block duration (days) among high/urgent tasks currently blocked; 0 if none. */
  maxBlockedHighOrUrgentDays: number;
  /** Average % of tasks completed across the project's milestones (null if the project has no milestones with tasks). */
  milestoneCompletionPercent: number | null;
  /** % of the project's startDate->targetDate timeline that has already elapsed (null if no targetDate is set). */
  milestonesElapsedPercent: number | null;
  /** True if the project's targetDate has passed and it still has incomplete tasks. */
  hasIncompleteTasksPastTargetDate: boolean;
}

export interface HealthStatusResult {
  status: HealthStatus;
  label: string;
  /** The individual, data-backed statements that triggered this classification (empty for on_track). */
  reasons: string[];
  /** `reasons` composed into a single human-readable sentence. */
  explanation: string;
}

function joinReasons(reasons: string[]): string {
  if (reasons.length === 0) return "";
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function computeHealthStatus(input: HealthStatusInput): HealthStatusResult {
  const overduePercent =
    input.openTaskCount > 0 ? (input.overdueOpenTaskCount / input.openTaskCount) * 100 : 0;

  const milestoneGap =
    input.milestoneCompletionPercent !== null && input.milestonesElapsedPercent !== null
      ? input.milestonesElapsedPercent - input.milestoneCompletionPercent
      : null;

  // -------------------------------------------------------------------
  // Delayed — checked first; any single reason here overrides at_risk.
  // -------------------------------------------------------------------
  const delayedReasons: string[] = [];

  if (input.openTaskCount > 0 && overduePercent > DELAYED_OVERDUE_PERCENT_THRESHOLD) {
    delayedReasons.push(
      `${input.overdueOpenTaskCount} of ${input.openTaskCount} open tasks are overdue (${Math.round(overduePercent)}%)`,
    );
  }
  if (input.maxBlockedHighOrUrgentDays > DELAYED_BLOCKED_DAYS_THRESHOLD) {
    delayedReasons.push(
      `a high-priority or urgent task has been blocked for ${input.maxBlockedHighOrUrgentDays} ${pluralize(
        input.maxBlockedHighOrUrgentDays,
        "day",
        "days",
      )} (over the ${DELAYED_BLOCKED_DAYS_THRESHOLD}-day threshold)`,
    );
  }
  if (input.hasIncompleteTasksPastTargetDate) {
    delayedReasons.push("the project's target date has passed with incomplete tasks remaining");
  }

  if (delayedReasons.length > 0) {
    return {
      status: "delayed",
      label: HEALTH_STATUS_LABELS.delayed,
      reasons: delayedReasons,
      explanation: `This project is marked Delayed because ${joinReasons(delayedReasons)}.`,
    };
  }

  // -------------------------------------------------------------------
  // At risk
  // -------------------------------------------------------------------
  const atRiskReasons: string[] = [];

  if (input.openTaskCount > 0 && overduePercent > AT_RISK_OVERDUE_PERCENT_THRESHOLD) {
    atRiskReasons.push(
      `${input.overdueOpenTaskCount} of ${input.openTaskCount} open tasks are overdue (${Math.round(overduePercent)}%)`,
    );
  }
  if (input.hasUrgentBlockedTask) {
    atRiskReasons.push("an urgent-priority task is currently blocked");
  } else if (input.blockedHighOrUrgentTaskCount >= AT_RISK_BLOCKED_HIGH_OR_URGENT_COUNT_THRESHOLD) {
    atRiskReasons.push(`${input.blockedHighOrUrgentTaskCount} high-priority tasks are currently blocked`);
  }
  if (milestoneGap !== null && milestoneGap > AT_RISK_MILESTONE_GAP_POINTS_THRESHOLD) {
    atRiskReasons.push(
      `milestone completion (${Math.round(input.milestoneCompletionPercent!)}%) is ${Math.round(
        milestoneGap,
      )} percentage points behind the project's elapsed timeline (${Math.round(input.milestonesElapsedPercent!)}%)`,
    );
  }

  if (atRiskReasons.length > 0) {
    return {
      status: "at_risk",
      label: HEALTH_STATUS_LABELS.at_risk,
      reasons: atRiskReasons,
      explanation: `This project is marked At Risk because ${joinReasons(atRiskReasons)}.`,
    };
  }

  // -------------------------------------------------------------------
  // On track
  // -------------------------------------------------------------------
  return {
    status: "on_track",
    label: HEALTH_STATUS_LABELS.on_track,
    reasons: [],
    explanation:
      `This project is On Track: ${input.overdueOpenTaskCount} of ${input.openTaskCount} open tasks are overdue ` +
      `and ${input.blockedHighOrUrgentTaskCount} high-priority/urgent tasks are blocked — both within the ` +
      `thresholds that would mark it At Risk or Delayed.`,
  };
}
