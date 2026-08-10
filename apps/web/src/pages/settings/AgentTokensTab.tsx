import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

interface AgentTokenSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
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

/**
 * Self-service AgentToken lifecycle for the caller's OWN tokens — the bearer
 * credential a user generates here to connect an MCP-compatible AI client
 * (Claude Desktop, Cursor, etc.) to ProjectHub, acting strictly within their
 * own permissions. Mirrors SessionsTab's revoke pattern (single click, no
 * confirmation dialog) and RegistrationTokensPanel's shown-once raw-secret
 * pattern (see that file for the precedent this closely follows).
 */
export default function AgentTokensTab(_props: SettingsTabProps) {
  const [tokens, setTokens] = useState<AgentTokenSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [justGeneratedToken, setJustGeneratedToken] = useState<string | null>(null);
  const [justGeneratedLabel, setJustGeneratedLabel] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function loadTokens() {
    try {
      const res = await api.get<{ agentTokens: AgentTokenSummary[] }>("/api/auth/me/agent-tokens");
      // The GET endpoint returns every token regardless of revocation state
      // (see agent-token.service.ts#listAgentTokens) — filter down to active
      // ones here so revoked tokens never linger in this list.
      setTokens(res.agentTokens.filter((t) => !t.revokedAt));
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load your agent tokens.");
      setTokens([]);
    }
  }

  useEffect(() => {
    loadTokens().catch(() => undefined);
  }, []);

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setGenerateError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const trimmed = label.trim();
      const res = await api.post<{ agentToken: AgentTokenSummary; rawToken: string }>(
        "/api/auth/me/agent-tokens",
        { label: trimmed },
      );
      setJustGeneratedToken(res.rawToken);
      setJustGeneratedLabel(trimmed);
      setLabel("");
      setTokens((prev) => [res.agentToken, ...(prev ?? [])]);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : "Could not generate an agent token.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!justGeneratedToken) return;
    try {
      await navigator.clipboard.writeText(justGeneratedToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleRevoke(token: AgentTokenSummary) {
    setListError(null);
    setRevokingId(token.id);
    try {
      await api.post(`/api/auth/me/agent-tokens/${token.id}/revoke`);
      setTokens((prev) => (prev ?? []).filter((t) => t.id !== token.id));
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not revoke this agent token.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>AI Agent Tokens</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Connect an MCP-compatible AI client — like Claude Desktop or Cursor — to act on ProjectHub on your behalf,
        strictly within your own permissions. Anything it does is logged in the activity feed under the client's
        name, alongside your own manual activity.
      </p>

      {generateError && <div className="ph-alert ph-alert-error">{generateError}</div>}

      {justGeneratedToken && (
        <div className="ph-alert ph-alert-success">
          <p style={{ marginTop: 0 }}>
            Token generated for &quot;{justGeneratedLabel}&quot;. Copy it now — it won&apos;t be shown again.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input readOnly value={justGeneratedToken} onFocus={(e) => e.target.select()} />
            <button type="button" className="ph-button-secondary" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleGenerate}>
        <div className="ph-field">
          <label htmlFor="agentTokenLabel">Label</label>
          <input
            id="agentTokenLabel"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Claude Desktop"
            maxLength={60}
            required
          />
        </div>
        <button className="ph-button" type="submit" disabled={generating || !label.trim()}>
          {generating ? "Generating..." : "Generate token"}
        </button>
      </form>

      {listError && <div className="ph-alert ph-alert-error">{listError}</div>}
      {tokens === null ? (
        <p>Loading...</p>
      ) : tokens.length === 0 ? (
        <div className="ph-empty-state">No agent tokens yet. Generate one below to connect an AI client.</div>
      ) : (
        <ul className="ph-assignee-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                <span className="truncate">{token.label}</span>
                <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                  Created {formatDate(token.createdAt)} ·{" "}
                  {token.lastUsedAt ? `Last used ${formatRelativeTime(token.lastUsedAt)}` : "Never used"}
                </span>
              </div>
              <button
                type="button"
                className="ph-remove-btn"
                disabled={revokingId === token.id}
                onClick={() => handleRevoke(token)}
              >
                {revokingId === token.id ? "Revoking..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
