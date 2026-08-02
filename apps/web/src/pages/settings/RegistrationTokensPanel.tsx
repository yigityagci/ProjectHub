import { useEffect, useState, type FormEvent } from "react";
import { ROLE_KEYS, ROLE_RANK, ROLE_DISPLAY_NAME, type RoleKey } from "@projecthub/shared";
import { api, ApiError } from "../../lib/api.js";

interface RegistrationTokenSummary {
  id: string;
  label: string | null;
  roleKey: string;
  roleName: string;
  createdAt: string;
  createdByEmail: string;
  createdByDisplayName: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
  usedByDisplayName: string | null;
  revokedAt: string | null;
}

/** Roles the caller may generate a token for — soft-filters to the caller's
 * own rank or below, mirroring assertCanAssignRole's server-side invariant.
 * Duplicated per this codebase's usual per-page convention (see
 * ManageTeamTab.tsx's identical helper) rather than sharing one import. */
function assignableRoles(ownRoleKey: string | null): RoleKey[] {
  if (!ownRoleKey || !(ROLE_KEYS as readonly string[]).includes(ownRoleKey)) return [];
  const ownRank = ROLE_RANK[ownRoleKey as RoleKey];
  return ROLE_KEYS.filter((key) => ROLE_RANK[key] <= ownRank);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function tokenStatus(token: RegistrationTokenSummary): string {
  if (token.revokedAt) return "Revoked";
  if (token.usedAt) {
    const who = token.usedByDisplayName ?? token.usedByEmail ?? "someone";
    return `Used by ${who} on ${formatDate(token.usedAt)}`;
  }
  if (new Date(token.expiresAt) < new Date()) return "Expired";
  return "Active";
}

function isActive(token: RegistrationTokenSummary): boolean {
  return !token.revokedAt && !token.usedAt && new Date(token.expiresAt) >= new Date();
}

/**
 * Registration tokens gate account creation (see
 * apps/api/src/auth/registration-token.service.ts) — generated here, from
 * within this workspace's Manage Team tab, each bound to a specific role.
 * Redeeming one both creates the account AND joins this workspace with
 * that role, atomically (see auth.service.ts's registerUser).
 */
export default function RegistrationTokensPanel({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string | null;
}) {
  const [tokens, setTokens] = useState<RegistrationTokenSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const roleOptions = assignableRoles(role);
  const [label, setLabel] = useState("");
  const [tokenRole, setTokenRole] = useState<RoleKey>("MEMBER");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [justGeneratedToken, setJustGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadTokens() {
    setListError(null);
    try {
      const res = await api.get<{ registrationTokens: RegistrationTokenSummary[] }>(
        `/api/workspaces/${workspaceId}/registration-tokens`,
      );
      setTokens(res.registrationTokens);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load registration tokens.");
      setTokens([]);
    }
  }

  useEffect(() => {
    loadTokens().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setGenerateError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const res = await api.post<{ rawToken: string }>(
        `/api/workspaces/${workspaceId}/registration-tokens`,
        { roleKey: tokenRole, ...(label.trim() ? { label: label.trim() } : {}) },
      );
      setJustGeneratedToken(res.rawToken);
      setLabel("");
      await loadTokens();
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : "Could not generate a registration token.");
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

  async function handleRevoke(token: RegistrationTokenSummary) {
    setListError(null);
    try {
      await api.post(`/api/workspaces/${workspaceId}/registration-tokens/${token.id}/revoke`);
      await loadTokens();
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not revoke this registration token.");
    }
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>Registration tokens</h1>
      <p style={{ fontSize: "0.85rem", color: "var(--ph-muted)" }}>
        Anyone creating a ProjectHub account needs a valid registration token. Each token is bound to a role —
        redeeming it creates the account and joins this workspace with that role, in one step.
      </p>

      {generateError && <div className="ph-alert ph-alert-error">{generateError}</div>}

      {justGeneratedToken && (
        <div className="ph-alert ph-alert-success">
          <p style={{ marginTop: 0 }}>
            Token generated. Copy it now — it will never be shown again.
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
          <label htmlFor="registrationTokenRole">Role</label>
          <select
            id="registrationTokenRole"
            value={tokenRole}
            onChange={(e) => setTokenRole(e.target.value as RoleKey)}
          >
            {roleOptions.map((key) => (
              <option key={key} value={key}>
                {ROLE_DISPLAY_NAME[key]}
              </option>
            ))}
          </select>
        </div>
        <div className="ph-field">
          <label htmlFor="registrationTokenLabel">Label (optional)</label>
          <input
            id="registrationTokenLabel"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Design team offsite"
          />
        </div>
        <button className="ph-button" type="submit" disabled={generating}>
          {generating ? "Generating..." : "Generate token"}
        </button>
      </form>

      {listError && <div className="ph-alert ph-alert-error">{listError}</div>}
      {tokens === null ? (
        <p>Loading...</p>
      ) : tokens.length === 0 ? (
        <div className="ph-empty-state">No registration tokens generated yet.</div>
      ) : (
        <ul className="ph-assignee-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                <span className="truncate">
                  {token.label ?? "(no label)"} · <strong>{token.roleName}</strong>
                </span>
                <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                  Generated by {token.createdByDisplayName} · {formatDate(token.createdAt)} · Expires{" "}
                  {formatDate(token.expiresAt)} · {tokenStatus(token)}
                </span>
              </div>
              {isActive(token) && (
                <button type="button" className="ph-remove-btn" onClick={() => handleRevoke(token)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
