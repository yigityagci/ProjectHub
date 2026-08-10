import type { PostfixStatusResult } from "./types.js";

function formatRelative(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Port-25 outbound check. Derives entirely from the `outboundSmtp` field
 * of GET /postfix-config/status — there is no separate port-25 endpoint
 * (see SelfHostedPostfixSection.tsx's shared `fetchStatus`). Deliberately
 * has NO hard "blocked/failed" red state: a failed connection attempt on
 * port 25 can mean an outright rejection or a silent drop, and this UI
 * cannot tell those apart from an unrelated network hiccup, so it only
 * ever shows the softer amber "Appears blocked".
 */
export default function Port25Check({
  outboundSmtp,
  loading,
  error,
  onRunCheck,
}: {
  outboundSmtp: PostfixStatusResult["outboundSmtp"] | null | undefined;
  loading: boolean;
  error: string | null;
  onRunCheck: () => void;
}) {
  let badgeLabel: string;
  let badgeClassName: string;
  if (loading) {
    badgeLabel = "Checking...";
    badgeClassName = "ph-badge";
  } else if (!outboundSmtp || !outboundSmtp.checked) {
    badgeLabel = "Unknown";
    badgeClassName = "ph-badge";
  } else if (outboundSmtp.reachable) {
    badgeLabel = "Open";
    badgeClassName = "ph-badge ph-badge-status-active";
  } else {
    badgeLabel = "Appears blocked";
    badgeClassName = "ph-badge ph-badge-stale";
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1rem" }}>Port 25 check</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>
            Tests whether this server can make outbound connections on port 25, the port mail servers use to
            deliver to each other.
          </p>
        </div>
        <button type="button" className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={onRunCheck} disabled={loading}>
          {loading ? "Checking..." : "Run check"}
        </button>
      </div>

      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", margin: "0.25rem 0 0.75rem" }}>
        <span className={badgeClassName}>{badgeLabel}</span>
        {outboundSmtp?.target && <span className="ph-subtitle" style={{ margin: 0 }}>Target: {outboundSmtp.target}</span>}
        {outboundSmtp?.latencyMs != null && outboundSmtp.reachable && (
          <span className="ph-subtitle" style={{ margin: 0 }}>{outboundSmtp.latencyMs}ms</span>
        )}
      </div>

      {outboundSmtp?.error && !outboundSmtp.reachable && (
        <p className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>{outboundSmtp.error}</p>
      )}

      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        {outboundSmtp?.checkedAt ? `Last checked ${formatRelative(outboundSmtp.checkedAt)}.` : "Not checked yet."}
      </p>

      <div className="ph-alert ph-alert-warning" style={{ marginBottom: 0 }}>
        This performs a real outbound connection attempt from this server on port 25. Many networks, ISPs, and
        cloud providers block outbound port 25 by default — some reject the connection outright, others silently
        drop it. "Appears blocked" means the connection didn't succeed; it does not always mean your provider is
        at fault, and an earlier "Open" result doesn't guarantee delivery will keep working if your network
        changes.
      </div>
    </div>
  );
}
