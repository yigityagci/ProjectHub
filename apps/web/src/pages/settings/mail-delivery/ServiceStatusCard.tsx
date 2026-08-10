import type { PostfixConfigView, PostfixStatusResult } from "./types.js";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function processBadgeClass(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "running") return "ph-badge ph-badge-status-active";
  if (normalized === "stopped") return "ph-badge";
  return "ph-badge ph-badge-error";
}

/**
 * Running/stopped/error process badges + last apply (reload) result +
 * manual "Refresh" button — no auto-polling anywhere in this codebase
 * (see core/scheduler.ts's doc comment), so this card only ever refreshes
 * when the admin explicitly asks it to, or right after this section's own
 * mount. Shares its data source (GET /postfix-config/status) with
 * Port25Check.tsx — see SelfHostedPostfixSection.tsx's single `fetchStatus`.
 */
export default function ServiceStatusCard({
  status,
  loading,
  error,
  config,
  onRefresh,
}: {
  status: PostfixStatusResult | null;
  loading: boolean;
  error: string | null;
  config: PostfixConfigView | null;
  onRefresh: () => void;
}) {
  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1rem" }}>Service status</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
            Live process status for the Postfix, OpenDKIM, and mail-control processes.
          </p>
        </div>
        <button type="button" className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      {loading && !status ? (
        <p className="ph-subtitle">Checking service status...</p>
      ) : status ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", margin: "0 0 0.75rem" }}>
            {Object.entries(status.processes ?? {}).map(([name, value]) => (
              <span key={name} className={processBadgeClass(value)}>
                {name}: {value}
              </span>
            ))}
          </div>
          {status.postfixVersion && (
            <p className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>Postfix version: {status.postfixVersion}</p>
          )}
          <p style={{ margin: "0 0 0.35rem" }}>
            {config?.lastAppliedAt ? (
              <>
                Last reload: {formatDateTime(config.lastAppliedAt)} —{" "}
                {config.lastApplyOk ? (
                  <span style={{ color: "var(--ph-success)", fontWeight: 600 }}>applied successfully</span>
                ) : (
                  <span style={{ color: "var(--ph-error)", fontWeight: 600 }}>
                    failed{config.lastApplyError ? `: ${config.lastApplyError}` : ""}
                  </span>
                )}
              </>
            ) : (
              "Configuration has not been applied yet."
            )}
          </p>
          {status.checkedAt && (
            <p className="ph-subtitle" style={{ margin: 0 }}>Checked {formatDateTime(status.checkedAt)}</p>
          )}
        </>
      ) : (
        <p className="ph-subtitle">No status information yet.</p>
      )}
    </div>
  );
}
