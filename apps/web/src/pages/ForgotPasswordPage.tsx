import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post("/api/auth/password-reset/request", { email });
      // Generic confirmation regardless of whether the email matched an
      // account — this endpoint never confirms account existence.
      setSuccess(true);
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
        <h1>Forgot password</h1>
        <p className="ph-subtitle">
          Enter your account's email address and we'll send you a password reset link.
        </p>
        {error && <div className="ph-alert ph-alert-error">{error}</div>}
        {success ? (
          <div className="ph-alert ph-alert-success">
            If an account exists for that email, we've sent a reset link.
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
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
            <button className="ph-button" type="submit" disabled={loading}>
              {loading ? "Sending..." : "Send reset link"}
            </button>
          </form>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link className="ph-link" to="/login">
            Back to log in
          </Link>
        </p>
      </div>
    </div>
  );
}
