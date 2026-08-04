import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import SettingsGearLink from "../components/SettingsGearLink.js";
import type { CurrentUser } from "../App.js";
import type { ActivityEvent } from "../components/ActivityFeed.js";
import { formatUserName } from "../lib/user-display.js";

interface AnalyticsTotals {
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  completionPercentage: number;
}

interface HealthStatus {
  status: "on_track" | "at_risk" | "delayed";
  label: string;
  reasons: string[];
  explanation: string;
}

interface Analytics {
  totals: AnalyticsTotals;
  completedOverTime: Array<{ day: string; count: number }>;
  workloadByAssignee: Array<{ userId: string; displayName: string; isDeleted: boolean; openTaskCount: number }>;
  tasksByStatus: Array<{ columnId: string; columnName: string; category: string; count: number }>;
  tasksByPriority: Record<string, number>;
  averageCompletionTimeHours: number | null;
  milestoneProgress: Array<{
    milestoneId: string;
    name: string;
    targetDate: string | null;
    totalTasks: number;
    completedTasks: number;
    completionPercentage: number | null;
  }>;
  projectProgressPercentage: number;
  recentActivity: ActivityEvent[];
  health: HealthStatus;
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="ph-bar-row">
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <div className="ph-bar-track min-w-0">
        <div className="ph-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right">{value}</span>
    </div>
  );
}

function formatHours(hours: number | null): string {
  if (hours === null) return "N/A";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default function AnalyticsPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    (async () => {
      try {
        const projectRes = await api.get<{ project: { name: string } }>(
          `/api/workspaces/${workspaceId}/projects/${projectId}`,
        );
        setProjectName(projectRes.project.name);

        const res = await api.get<{ analytics: Analytics }>(
          `/api/workspaces/${workspaceId}/projects/${projectId}/analytics`,
        );
        setAnalytics(res.analytics);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          navigate(`/workspace/${workspaceId}/projects`);
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          setError("You don't have permission to view analytics for this project.");
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not load analytics.");
      }
    })();
  }, [workspaceId, projectId, navigate]);

  const maxCompletedPerDay = analytics
    ? Math.max(1, ...analytics.completedOverTime.map((d) => d.count))
    : 1;
  const maxWorkload = analytics
    ? Math.max(1, ...analytics.workloadByAssignee.map((w) => w.openTaskCount))
    : 1;
  const maxStatusCount = analytics ? Math.max(1, ...analytics.tasksByStatus.map((s) => s.count)) : 1;
  const maxPriorityCount = analytics
    ? Math.max(1, ...Object.values(analytics.tasksByPriority))
    : 1;

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
          <SettingsGearLink />
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects/${projectId}/categories`}>{projectName || "..."}</Link> /
          Analytics
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Analytics</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              {projectName || "This project"}'s real-time operational metrics and health status.
            </p>
          </div>
        </div>

        {error && <div className="ph-alert ph-alert-error">{error}</div>}

        {!analytics ? (
          error ? null : <p>Loading...</p>
        ) : (
          <>
            <div className={`ph-health-banner ph-health-${analytics.health.status}`}>
              <span className="ph-health-label">{analytics.health.label}</span>
              <p className="ph-health-explanation">{analytics.health.explanation}</p>
            </div>

            <div className="ph-stat-grid">
              <div className="ph-stat-card">
                <span className="ph-stat-value">{analytics.totals.totalTasks}</span>
                <span className="ph-stat-label">Total tasks</span>
              </div>
              <div className="ph-stat-card">
                <span className="ph-stat-value">{analytics.totals.completedTasks}</span>
                <span className="ph-stat-label">Completed</span>
              </div>
              <div className="ph-stat-card">
                <span className="ph-stat-value">{analytics.totals.overdueTasks}</span>
                <span className="ph-stat-label">Overdue</span>
              </div>
              <div className="ph-stat-card">
                <span className="ph-stat-value">{analytics.totals.blockedTasks}</span>
                <span className="ph-stat-label">Blocked</span>
              </div>
              <div className="ph-stat-card">
                <span className="ph-stat-value">{analytics.totals.completionPercentage}%</span>
                <span className="ph-stat-label">Progress</span>
              </div>
              <div className="ph-stat-card">
                <span className="ph-stat-value">{formatHours(analytics.averageCompletionTimeHours)}</span>
                <span className="ph-stat-label">Avg. completion time</span>
              </div>
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Tasks completed — last 30 days</h2>
              <div className="ph-sparkline">
                {analytics.completedOverTime.map((d) => (
                  <div
                    key={d.day}
                    className="ph-sparkline-bar"
                    title={`${d.day}: ${d.count}`}
                    style={{ height: `${Math.max(4, (d.count / maxCompletedPerDay) * 60)}px` }}
                  />
                ))}
              </div>
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Workload by assignee (open tasks)</h2>
              {analytics.workloadByAssignee.length === 0 ? (
                <div className="ph-empty-state">No open tasks are assigned to anyone yet.</div>
              ) : (
                analytics.workloadByAssignee.map((w) => (
                  <BarRow
                    key={w.userId}
                    label={formatUserName(w.displayName, w.isDeleted)}
                    value={w.openTaskCount}
                    max={maxWorkload}
                  />
                ))
              )}
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Tasks by status</h2>
              {analytics.tasksByStatus.map((s) => (
                <BarRow key={s.columnId} label={s.columnName} value={s.count} max={maxStatusCount} />
              ))}
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Tasks by priority</h2>
              {Object.entries(analytics.tasksByPriority).map(([priority, count]) => (
                <BarRow key={priority} label={priority} value={count} max={maxPriorityCount} />
              ))}
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Milestone progress</h2>
              {analytics.milestoneProgress.length === 0 ? (
                <div className="ph-empty-state">No milestones yet.</div>
              ) : (
                analytics.milestoneProgress.map((m) => (
                  <BarRow
                    key={m.milestoneId}
                    label={m.name}
                    value={m.completedTasks}
                    max={Math.max(1, m.totalTasks)}
                  />
                ))
              )}
            </div>

            <div className="ph-card ph-card-wide ph-analytics-section">
              <h2>Recent activity</h2>
              {analytics.recentActivity.length === 0 ? (
                <div className="ph-empty-state">No activity yet.</div>
              ) : (
                <ul className="ph-activity-list">
                  {analytics.recentActivity.map((e) => (
                    <li key={e.id}>
                      {e.type.replace(/_/g, " ")}
                      <span className="ph-activity-time">{new Date(e.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
