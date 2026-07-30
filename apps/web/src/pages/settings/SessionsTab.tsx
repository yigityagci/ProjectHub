import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * Implementation-time call: a small best-effort browser/OS parse, falling
 * back to the raw user-agent string when it doesn't match any known
 * pattern — an honest raw string beats a confidently-wrong friendly guess.
 */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return userAgent;
}

function formatRelativeTime(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

export default function SessionsTab({ onLoggedOut }: SettingsTabProps) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<{ sessions: Session[] }>("/api/auth/sessions");
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your sessions.");
      setSessions([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function handleRevoke(session: Session) {
    setError(null);
    setRevokingId(session.id);
    try {
      await api.post(`/api/auth/sessions/${session.id}/revoke`);
      if (session.current) {
        // Revoking your own current session is, from the user's point of
        // view, indistinguishable from a manual logout.
        onLoggedOut();
        navigate("/login");
        return;
      }
      setSessions((prev) => (prev ?? []).filter((s) => s.id !== session.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke this session.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Active Sessions</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Manage your active sessions across devices.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      {sessions === null ? (
        <p>Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="ph-empty-state">No active sessions found.</div>
      ) : (
        <ul className="ph-assignee-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                <span className="truncate" title={s.userAgent ?? undefined}>
                  {describeUserAgent(s.userAgent)}
                  {s.current && (
                    <span className="ph-badge ph-badge-current" style={{ marginLeft: "0.5rem" }}>
                      This device
                    </span>
                  )}
                </span>
                <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                  {s.ip ?? "Unknown IP"} · Last seen {formatRelativeTime(s.lastSeenAt)}
                </span>
              </div>
              <button
                type="button"
                className="ph-remove-btn"
                disabled={revokingId === s.id}
                onClick={() => handleRevoke(s)}
              >
                {revokingId === s.id ? "Revoking..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
