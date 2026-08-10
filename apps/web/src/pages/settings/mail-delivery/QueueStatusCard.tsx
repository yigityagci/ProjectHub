import type { PostfixQueueResult } from "./types.js";

function formatAge(arrivalAt: string): string {
  const ms = Date.now() - new Date(arrivalAt).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Three ph-stat-card tiles (same pattern as AnalyticsPage.tsx's stat
 * grid) — a healthy, all-zero queue is a normal, non-alarming "0", not an
 * empty/error state.
 */
export default function QueueStatusCard({
  queue,
  loading,
  error,
  onRefresh,
}: {
  queue: PostfixQueueResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const dash = "—";
  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1rem" }}>Queue status</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
            The current state of Postfix's outgoing mail queue.
          </p>
        </div>
        <button type="button" className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      <div className="ph-stat-grid" style={{ marginBottom: 0 }}>
        <div className="ph-stat-card">
          <span className="ph-stat-value">{loading && !queue ? dash : queue?.counts?.total ?? dash}</span>
          <span className="ph-stat-label">Queued</span>
        </div>
        <div className="ph-stat-card">
          <span className="ph-stat-value">
            {loading && !queue
              ? dash
              : queue?.oldestArrivalAt
                ? formatAge(queue.oldestArrivalAt)
                : queue?.counts
                  ? "None"
                  : dash}
          </span>
          <span className="ph-stat-label">Oldest message age</span>
        </div>
        <div className="ph-stat-card">
          <span className="ph-stat-value">{loading && !queue ? dash : queue?.counts?.deferred ?? dash}</span>
          <span className="ph-stat-label">Deferred</span>
        </div>
      </div>
    </div>
  );
}
