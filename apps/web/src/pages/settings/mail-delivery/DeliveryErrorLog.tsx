import type { PostfixQueueResult } from "./types.js";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * Most-recent-first list of recent delivery errors (from the same
 * GET /postfix-config/queue call as QueueStatusCard's tiles) — reuses the
 * .ph-assignee-list row pattern (see RegistrationTokensPanel.tsx) rather
 * than inventing a new list style.
 */
export default function DeliveryErrorLog({
  queue,
  loading,
  error,
}: {
  queue: PostfixQueueResult | null;
  loading: boolean;
  error: string | null;
}) {
  const errors = [...(queue?.recentErrors ?? [])].sort(
    (a, b) => new Date(b.arrivalAt).getTime() - new Date(a.arrivalAt).getTime(),
  );

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>Delivery errors</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        The most recent messages that failed to deliver, most recent first.
      </p>

      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      {loading && !queue ? (
        <p className="ph-subtitle">Loading...</p>
      ) : errors.length === 0 ? (
        !error && <div className="ph-empty-state">No delivery errors.</div>
      ) : (
        <>
          <ul className="ph-assignee-list">
            {errors.map((entry) => (
              <li key={entry.queueId}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                  <span className="truncate">{entry.recipient}</span>
                  <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                    {formatDateTime(entry.arrivalAt)} · {entry.reason}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {queue?.truncated && (
            <p className="ph-subtitle" style={{ margin: "0.5rem 0 0" }}>
              Showing the most recent errors only — more may exist in the queue.
            </p>
          )}
        </>
      )}
    </div>
  );
}
