import { describe, expect, it } from "vitest";
import {
  computeHealthStatus,
  DELAYED_OVERDUE_PERCENT_THRESHOLD,
  AT_RISK_OVERDUE_PERCENT_THRESHOLD,
  DELAYED_BLOCKED_DAYS_THRESHOLD,
  type HealthStatusInput,
} from "../src/analytics/health-status.js";

const BASELINE: HealthStatusInput = {
  openTaskCount: 10,
  overdueOpenTaskCount: 0,
  blockedHighOrUrgentTaskCount: 0,
  hasUrgentBlockedTask: false,
  maxBlockedHighOrUrgentDays: 0,
  milestoneCompletionPercent: null,
  milestonesElapsedPercent: null,
  hasIncompleteTasksPastTargetDate: false,
};

describe("computeHealthStatus (rule-based, explainable health status)", () => {
  it("classifies a healthy project as on_track with a data-backed explanation", () => {
    const result = computeHealthStatus({ ...BASELINE, overdueOpenTaskCount: 1 }); // 10%, below the at_risk threshold
    expect(result.status).toBe("on_track");
    expect(result.label).toBe("On Track");
    expect(result.reasons).toHaveLength(0);
    expect(result.explanation).toContain("1");
    expect(result.explanation).toContain("10");
  });

  it("classifies at_risk when overdue-open-task percentage exceeds the at_risk threshold but not the delayed one", () => {
    // 3 of 10 open tasks overdue = 30%, above AT_RISK (20%) but below DELAYED (40%).
    const overdueOpenTaskCount = 3;
    const result = computeHealthStatus({ ...BASELINE, overdueOpenTaskCount });
    const percent = (overdueOpenTaskCount / BASELINE.openTaskCount) * 100;
    expect(percent).toBeGreaterThan(AT_RISK_OVERDUE_PERCENT_THRESHOLD);
    expect(percent).toBeLessThanOrEqual(DELAYED_OVERDUE_PERCENT_THRESHOLD);

    expect(result.status).toBe("at_risk");
    expect(result.label).toBe("At Risk");
    // The explanation must reflect the exact numbers passed in, not a canned string.
    expect(result.explanation).toContain("3 of 10 open tasks are overdue (30%)");
  });

  it("classifies at_risk when any urgent-priority task is currently blocked", () => {
    const result = computeHealthStatus({
      ...BASELINE,
      blockedHighOrUrgentTaskCount: 1,
      hasUrgentBlockedTask: true,
      maxBlockedHighOrUrgentDays: 2, // under the delayed 7-day threshold
    });
    expect(result.status).toBe("at_risk");
    expect(result.explanation).toContain("urgent-priority task is currently blocked");
  });

  it("classifies delayed when overdue-open-task percentage exceeds the delayed threshold", () => {
    // 5 of 10 open tasks overdue = 50%, above the DELAYED threshold.
    const overdueOpenTaskCount = 5;
    const result = computeHealthStatus({ ...BASELINE, overdueOpenTaskCount });
    const percent = (overdueOpenTaskCount / BASELINE.openTaskCount) * 100;
    expect(percent).toBeGreaterThan(DELAYED_OVERDUE_PERCENT_THRESHOLD);

    expect(result.status).toBe("delayed");
    expect(result.label).toBe("Delayed");
    expect(result.explanation).toContain("5 of 10 open tasks are overdue (50%)");
  });

  it("classifies delayed when a high/urgent task has been blocked past the delayed-days threshold, even with low overdue rate", () => {
    const result = computeHealthStatus({
      ...BASELINE,
      overdueOpenTaskCount: 0,
      blockedHighOrUrgentTaskCount: 1,
      hasUrgentBlockedTask: true,
      maxBlockedHighOrUrgentDays: DELAYED_BLOCKED_DAYS_THRESHOLD + 1,
    });
    expect(result.status).toBe("delayed");
    expect(result.explanation).toContain(`blocked for ${DELAYED_BLOCKED_DAYS_THRESHOLD + 1} days`);
  });

  it("classifies delayed when the target date has passed with incomplete tasks remaining", () => {
    const result = computeHealthStatus({ ...BASELINE, hasIncompleteTasksPastTargetDate: true });
    expect(result.status).toBe("delayed");
    expect(result.explanation).toContain("target date has passed");
  });

  it("classifies at_risk when milestone completion lags materially behind elapsed project time", () => {
    const result = computeHealthStatus({
      ...BASELINE,
      milestoneCompletionPercent: 20,
      milestonesElapsedPercent: 60, // 40-point gap, over the 20-point at_risk threshold
    });
    expect(result.status).toBe("at_risk");
    expect(result.explanation).toContain("milestone completion (20%)");
    expect(result.explanation).toContain("elapsed timeline (60%)");
  });

  it("ignores openTaskCount of 0 for the overdue-percentage rule (no division by zero / false positives)", () => {
    const result = computeHealthStatus({ ...BASELINE, openTaskCount: 0, overdueOpenTaskCount: 0 });
    expect(result.status).toBe("on_track");
  });
});
