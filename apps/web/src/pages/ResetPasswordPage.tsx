import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";

const INVALID_LINK_MESSAGE =
  "This password reset link is invalid or has expired. Please request a new one.";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/password-reset/confirm", { token, password });
      setSuccess(true);
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ph-shell ph-shell-auth">
      <div className="ph-auth-box">
        <Brand />
        <div className="ph-card">
        <h1>Reset password</h1>
        {!token && !success && (
          <div className="ph-alert ph-alert-error">{INVALID_LINK_MESSAGE}</div>
        )}

        {token && !success && (
          <>
            <p className="ph-subtitle">Choose a new password for your account.</p>
            {error && <div className="ph-alert ph-alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="ph-field">
                <label htmlFor="password">New password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="ph-field">
                <label htmlFor="confirmPassword">Confirm new password</label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <button className="ph-button" type="submit" disabled={loading}>
                {loading ? "Resetting..." : "Reset password"}
              </button>
            </form>
          </>
        )}

        {success && (
          <div className="ph-alert ph-alert-success">
            Your password has been reset. Redirecting you to log in...
          </div>
        )}

        <p style={{ marginTop: "1rem" }}>
          <Link className="ph-link" to="/login">
            Log in now
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
