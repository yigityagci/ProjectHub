import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import type { CurrentUser } from "../App.js";

interface InvitationPreview {
  workspaceName: string;
  roleName: string;
  roleKey: string;
  email: string;
}

export default function InviteAcceptPage({ user }: { user: CurrentUser | null }) {
  const [searchParams] = useSearchParams();
  const [tokenInput, setTokenInput] = useState(searchParams.get("token") ?? "");
  const token = searchParams.get("token") ?? tokenInput;
  const navigate = useNavigate();

  // Round-trip target for an invited-but-not-logged-in user: carried
  // through /login or /register as a `redirect` query param (same "token"
  // param name this page itself reads its invite token from) so they land
  // back on this exact invite/accept link once authenticated.
  const redirectTarget = `/invite/accept?token=${encodeURIComponent(token)}`;

  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!searchParams.get("token")) return;
    setError(null);
    api
      .get<InvitationPreview>(`/api/invitations/${encodeURIComponent(searchParams.get("token")!)}`)
      .then(setPreview)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, [searchParams]);

  async function handleAccept() {
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ workspace: { name: string } }>(
        `/api/invitations/${encodeURIComponent(token)}/accept`,
      );
      setSuccess(`You've joined ${res.workspace.name}.`);
      setTimeout(() => navigate("/"), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ph-shell ph-shell-auth">
      <Brand />
      <div className="ph-card">
        <h1>Accept invitation</h1>
        <p className="ph-subtitle">
          Paste the invitation token from your invite email/link, or use the link directly.
        </p>

        {!searchParams.get("token") && (
          <div className="ph-field">
            <label htmlFor="token">Invitation token</label>
            <input id="token" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
          </div>
        )}

        {error && <div className="ph-alert ph-alert-error">{error}</div>}
        {success && <div className="ph-alert ph-alert-success">{success}</div>}

        {preview && !success && (
          <>
            <p>
              You've been invited to <strong>{preview.workspaceName}</strong> as{" "}
              <strong>{preview.roleName}</strong>.
            </p>
            {user ? (
              <button className="ph-button" onClick={handleAccept} disabled={loading}>
                {loading ? "Accepting..." : "Accept invitation"}
              </button>
            ) : (
              <p className="ph-subtitle">
                Please{" "}
                <Link className="ph-link" to={`/login?redirect=${encodeURIComponent(redirectTarget)}`}>
                  log in
                </Link>{" "}
                or{" "}
                <Link className="ph-link" to={`/register?redirect=${encodeURIComponent(redirectTarget)}`}>
                  register
                </Link>{" "}
                with <strong>{preview.email}</strong> first, then you'll be returned here to accept.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
