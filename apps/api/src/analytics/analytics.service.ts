import type { RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { listActivityEvents } from "../activity/activity.service.js";
import { listVisibleCategoryIdsForUser } from "../projects/categories.service.js";
import { computeHealthStatus, type HealthStatusInput } from "./health-status.js";

const COMPLETED_OVER_TIME_WINDOW_DAYS = 30;
const RECENT_ACTIVITY_LIMIT = 10;

const DONE_CATEGORY = "done";

interface ProjectTimelineFields {
  startDate: Date | null;
  targetDate: Date | null;
  createdAt: Date;
}

function isDoneTask(t: { column: { category: string } }): boolean {
  return t.column.category === DONE_CATEGORY;
}

/**
 * Computes every Phase 6 analytics figure for a single project, plus the
 * rule-based health-status classification. Most metrics are derived from a
 * single `Task.findMany` pass in JS (simpler and equally clear for these
 * aggregate-over-a-small-collection cases); the "tasks completed over time"
 * series uses a raw parameterized SQL query instead, since a zero-filled
 * daily bucket series over a fixed window is a clearly better fit for SQL
 * (`generate_series` + a date-truncated join) than pulling every row into
 * JS and re-deriving the calendar.
 */
export async function getProjectAnalytics(
  workspaceId: string,
  projectId: string,
  project: ProjectTimelineFields,
  viewer: { userId: string; roleKey: RoleKey },
) {
  const now = new Date();

  // Analytics stay project-wide (aggregating across every category the
  // caller can see) but the underlying task query is narrowed to only
  // tasks whose category is in the caller's visible-category set, so a
  // caller without access to a private category never sees that
  // category's tasks reflected in totals/workload/status/priority/
  // completion-time/health-status numbers. Uses the same shared helper as
  // category listing and activity-feed filtering.
  const visibleCategoryIds = await listVisibleCategoryIdsForUser(projectId, viewer.userId, viewer.roleKey);

  const tasks = await prisma.task.findMany({
    where: { projectId, workspaceId, categoryId: { in: visibleCategoryIds } },
    include: {
      column: true,
      assignees: { include: { user: true } },
      blockedByEdges: { include: { blockingTask: { include: { column: true } } } },
    },
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(isDoneTask).length;
  const openTasks = tasks.filter((t) => !isDoneTask(t));
  const overdueOpenTasks = openTasks.filter((t) => t.dueDate !== null && t.dueDate.getTime() < now.getTime());

  const isBlocked = (t: (typeof tasks)[number]) =>
    t.blockedByEdges.some((edge) => edge.blockingTask.column.category !== DONE_CATEGORY);
  const blockedOpenTasks = openTasks.filter(isBlocked);

  const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // ---- Workload by assignee (open task count per assignee) ----
  const workloadMap = new Map<string, { userId: string; displayName: string; openTaskCount: number }>();
  for (const t of openTasks) {
    for (const a of t.assignees) {
      const entry = workloadMap.get(a.userId) ?? {
        userId: a.userId,
        displayName: a.user.displayName,
        openTaskCount: 0,
      };
      entry.openTaskCount += 1;
      workloadMap.set(a.userId, entry);
    }
  }
  const workloadByAssignee = [...workloadMap.values()].sort((a, b) => b.openTaskCount - a.openTaskCount);

  // ---- Tasks by status (per board column) ----
  const statusMap = new Map<
    string,
    { columnId: string; columnName: string; category: string; count: number }
  >();
  for (const t of tasks) {
    const entry = statusMap.get(t.columnId) ?? {
      columnId: t.columnId,
      columnName: t.column.name,
      category: t.column.category,
      count: 0,
    };
    entry.count += 1;
    statusMap.set(t.columnId, entry);
  }
  const tasksByStatus = [...statusMap.values()];

  // ---- Tasks by priority ----
  const tasksByPriority: Record<string, number> = { low: 0, medium: 0, high: 0, urgent: 0 };
  for (const t of tasks) {
    tasksByPriority[t.priority] = (tasksByPriority[t.priority] ?? 0) + 1;
  }

  // ---- Average completion time (mean of completedAt - createdAt) ----
  const completedWithTimestamps = tasks.filter((t) => t.completedAt !== null);
  const averageCompletionTimeHours =
    completedWithTimestamps.length > 0
      ? completedWithTimestamps.reduce(
          (sum, t) => sum + (t.completedAt!.getTime() - t.createdAt.getTime()),
          0,
        ) /
        completedWithTimestamps.length /
        (1000 * 60 * 60)
      : null;

  // ---- Milestone progress (total vs. completed tasks per milestone) ----
  const milestones = await prisma.milestone.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  const milestoneProgress = milestones.map((m) => {
    const milestoneTasks = tasks.filter((t) => t.milestoneId === m.id);
    const totalMilestoneTasks = milestoneTasks.length;
    const completedMilestoneTasks = milestoneTasks.filter(isDoneTask).length;
    return {
      milestoneId: m.id,
      name: m.name,
      targetDate: m.targetDate,
      completedAt: m.completedAt,
      totalTasks: totalMilestoneTasks,
      completedTasks: completedMilestoneTasks,
      completionPercentage:
        totalMilestoneTasks > 0 ? Math.round((completedMilestoneTasks / totalMilestoneTasks) * 100) : null,
    };
  });

  // ---- Tasks completed over time (raw SQL: zero-filled daily buckets) ----
  const since = new Date(now.getTime() - (COMPLETED_OVER_TIME_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  const completedOverTimeRows = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
    SELECT gs::date AS day, COALESCE(t.count, 0)::bigint AS count
    FROM generate_series(${since}::date, ${now}::date, interval '1 day') AS gs
    LEFT JOIN (
      SELECT date_trunc('day', "completedAt")::date AS day, COUNT(*) AS count
      FROM tasks
      WHERE "projectId" = ${projectId} AND "completedAt" IS NOT NULL AND "completedAt" >= ${since}
        AND "categoryId" = ANY(${visibleCategoryIds}::text[])
      GROUP BY date_trunc('day', "completedAt")
    ) t ON t.day = gs
    ORDER BY gs;
  `;
  const completedOverTime = completedOverTimeRows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    count: Number(row.count),
  }));

  // ---- Inputs for the rule-based health-status engine ----
  const highOrUrgentOpenTasks = openTasks.filter((t) => t.priority === "high" || t.priority === "urgent");
  const blockedHighOrUrgentTasks = highOrUrgentOpenTasks.filter(isBlocked);
  const hasUrgentBlockedTask = blockedHighOrUrgentTasks.some((t) => t.priority === "urgent");

  let maxBlockedHighOrUrgentDays = 0;
  for (const t of blockedHighOrUrgentTasks) {
    for (const edge of t.blockedByEdges) {
      if (edge.blockingTask.column.category === DONE_CATEGORY) continue;
      const days = (now.getTime() - edge.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (days > maxBlockedHighOrUrgentDays) maxBlockedHighOrUrgentDays = days;
    }
  }
  maxBlockedHighOrUrgentDays = Math.floor(maxBlockedHighOrUrgentDays);

  const milestonesWithTasks = milestoneProgress.filter((m) => m.completionPercentage !== null);
  const milestoneCompletionPercent =
    milestonesWithTasks.length > 0
      ? milestonesWithTasks.reduce((sum, m) => sum + (m.completionPercentage ?? 0), 0) /
        milestonesWithTasks.length
      : null;

  let milestonesElapsedPercent: number | null = null;
  if (project.targetDate) {
    const start = project.startDate ?? project.createdAt;
    const totalMs = project.targetDate.getTime() - start.getTime();
    if (totalMs > 0) {
      const elapsedMs = now.getTime() - start.getTime();
      milestonesElapsedPercent = Math.max(0, (elapsedMs / totalMs) * 100);
    }
  }

  const hasIncompleteTasksPastTargetDate =
    project.targetDate !== null &&
    now.getTime() > project.targetDate.getTime() &&
    completedTasks < totalTasks;

  const healthInput: HealthStatusInput = {
    openTaskCount: openTasks.length,
    overdueOpenTaskCount: overdueOpenTasks.length,
    blockedHighOrUrgentTaskCount: blockedHighOrUrgentTasks.length,
    hasUrgentBlockedTask,
    maxBlockedHighOrUrgentDays,
    milestoneCompletionPercent,
    milestonesElapsedPercent,
    hasIncompleteTasksPastTargetDate,
  };
  const health = computeHealthStatus(healthInput);

  // recentActivity automatically inherits the same category-visibility
  // filtering as the activity feed endpoint (see
  // activity.service.ts#listActivityEvents), by passing the same viewer.
  const recentActivity = await listActivityEvents(projectId, { limit: RECENT_ACTIVITY_LIMIT }, viewer);

  return {
    totals: {
      totalTasks,
      completedTasks,
      overdueTasks: overdueOpenTasks.length,
      blockedTasks: blockedOpenTasks.length,
      completionPercentage,
    },
    completedOverTime,
    workloadByAssignee,
    tasksByStatus,
    tasksByPriority,
    averageCompletionTimeHours,
    milestoneProgress,
    projectProgressPercentage: completionPercentage,
    recentActivity: recentActivity.events,
    health,
  };
}
