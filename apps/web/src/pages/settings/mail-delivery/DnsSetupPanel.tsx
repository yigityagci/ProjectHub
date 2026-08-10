import { useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api.js";
import CopyableCode from "./CopyableCode.js";
import type { DnsCheckResult } from "./types.js";

type DnsRecordKey = "a" | "spf" | "dkim" | "dmarc" | "ptr";

const ROW_DEFS: Array<{ key: DnsRecordKey; label: string }> = [
  { key: "a", label: "A" },
  { key: "spf", label: "SPF" },
  { key: "dkim", label: "DKIM" },
  { key: "dmarc", label: "DMARC" },
  { key: "ptr", label: "PTR (reverse DNS)" },
];

/**
 * DNS verification table for A/SPF/DKIM/DMARC/PTR. PTR is included as a
 * table row alongside the others (rather than pulled out into a separate
 * non-table explanatory block, per the design brief's judgment call) since
 * the API already computes a full `checks.ptr` result identical in shape
 * to the other four — building a second, differently-shaped UI just to
 * withhold a result the API hands us for free isn't worth the added
 * complexity. Its distinct nature (can't be set in your own DNS zone) is
 * instead called out via an always-visible note under that specific row.
 */
export default function DnsSetupPanel({ hasConfig }: { hasConfig: boolean }) {
  const [dns, setDns] = useState<DnsCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchDns() {
    setError(null);
    setLoading(true);
    try {
      const res = await api.get<DnsCheckResult>("/api/platform/postfix-config/dns-check");
      setDns(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check DNS records.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (hasConfig) {
      fetchDns().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasConfig]);

  function statusFor(check: { present: boolean; ok: boolean } | undefined): { label: string; className: string } {
    if (!check) return { label: loading ? "Checking..." : "Unknown", className: "ph-badge" };
    if (!check.present) return { label: "Missing", className: "ph-badge ph-badge-stale" };
    if (!check.ok) return { label: "Mismatched", className: "ph-badge ph-badge-error" };
    return { label: "Verified", className: "ph-badge ph-badge-status-active" };
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1rem" }}>DNS setup</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>
            The DNS records below verify that mail from your domain is authorized and authentic. Publish them
            with your DNS provider.
          </p>
        </div>
        <button
          type="button"
          className="ph-button ph-button-secondary"
          style={{ width: "auto" }}
          onClick={fetchDns}
          disabled={loading || !hasConfig}
        >
          {loading ? "Checking..." : "Recheck"}
        </button>
      </div>

      <div className="ph-alert ph-alert-warning">
        This check is best-effort. DNS changes can take anywhere from a few minutes to 48 hours to propagate, and
        some resolvers cache old values longer than others. A "Missing" or "Mismatched" result here doesn't always
        mean your DNS is wrong yet — recheck after a few hours if you just made a change.
      </div>

      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      {!hasConfig ? (
        <div className="ph-empty-state">Save the sending domain and mail hostname below before checking DNS.</div>
      ) : (
        <ul className="ph-assignee-list">
          {ROW_DEFS.map((def) => {
            const entry = dns?.records[def.key];
            const check = dns?.checks[def.key];
            const status = statusFor(check);
            return (
              <li key={def.key} style={{ alignItems: "flex-start" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", minWidth: 0, flex: 1 }}>
                  <span>
                    <strong>{def.label}</strong>
                    {entry && (
                      <>
                        {" "}
                        — <code>{entry.name}</code> ({entry.type})
                      </>
                    )}
                  </span>
                  {entry?.value && <CopyableCode value={entry.value} />}
                  {check && (
                    <span className="ph-subtitle" style={{ margin: 0 }}>
                      {check.note}
                    </span>
                  )}
                  {def.key === "ptr" && (
                    <span className="ph-subtitle" style={{ margin: 0 }}>
                      Reverse DNS (PTR) can't be set in your domain's DNS zone — it's configured by your hosting or
                      cloud provider against this server's outbound IP address. Contact your hosting provider's
                      support to request it if it isn't already set.
                    </span>
                  )}
                </div>
                <span className={status.className}>{status.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
