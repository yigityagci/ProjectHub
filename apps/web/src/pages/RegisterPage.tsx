import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ROLE_DISPLAY_NAME, type RoleKey } from "@projecthub/shared";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";

export default function RegisterPage() {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect");
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registrationToken, setRegistrationToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [joinedWorkspace, setJoinedWorkspace] = useState<{ name: string; roleKey: RoleKey } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Register does NOT set a session cookie / auto-login (see
      // apps/api/src/auth/auth.routes.ts) — the caller must log in
      // separately afterwards, mirroring ResetPasswordPage's
      // success-message-then-redirect pattern.
      const res = await api.post<{ workspace: { name: string }; role: RoleKey }>(
        "/api/auth/register",
        { email, password, displayName, registrationToken },
      );
      setJoinedWorkspace({ name: res.workspace.name, roleKey: res.role });
      setSuccess(true);
      const loginTarget = redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/login";
      setTimeout(() => navigate(loginTarget), 1500);
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
        <h1>Create your account</h1>
        <p className="ph-subtitle">Register to join or create ProjectHub workspaces.</p>

        {!success && (
          <>
            {error && <div className="ph-alert ph-alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="ph-field">
                <label htmlFor="displayName">Your name</label>
                <input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </div>
              <div className="ph-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="ph-field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="ph-field">
                <label htmlFor="registrationToken">Registration token</label>
                <input
                  id="registrationToken"
                  value={registrationToken}
                  onChange={(e) => setRegistrationToken(e.target.value)}
                  placeholder="Paste the token an admin gave you"
                  required
                />
              </div>
              <button className="ph-button" type="submit" disabled={loading}>
                {loading ? "Creating account..." : "Create account"}
              </button>
            </form>
          </>
        )}

        {success && (
          <div className="ph-alert ph-alert-success">
            Your account has been created
            {joinedWorkspace &&
              ` and you've joined ${joinedWorkspace.name} as ${ROLE_DISPLAY_NAME[joinedWorkspace.roleKey]}`}
            . Redirecting you to log in...
          </div>
        )}

        <p style={{ marginTop: "1rem" }}>
          <Link className="ph-link" to={redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/login"}>
            Already have an account? Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
