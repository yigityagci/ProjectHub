import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";

export default function RegisterPage() {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect");
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
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
      await api.post("/api/auth/register", { email, password, displayName });
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
              <button className="ph-button" type="submit" disabled={loading}>
                {loading ? "Creating account..." : "Create account"}
              </button>
            </form>
          </>
        )}

        {success && (
          <div className="ph-alert ph-alert-success">
            Your account has been created. Redirecting you to log in...
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
