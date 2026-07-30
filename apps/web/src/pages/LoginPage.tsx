import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import type { CurrentUser } from "../App.js";

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ user: CurrentUser }>("/api/auth/login", { email, password });
      onLoggedIn(res.user);
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
        <h1>Log in</h1>
        <p className="ph-subtitle">Access your ProjectHub workspaces.</p>
        {error && <div className="ph-alert ph-alert-error">{error}</div>}
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
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>
        <p style={{ marginTop: "1rem" }}>
          <Link className="ph-link" to="/invite/accept">
            Have an invitation link? Paste its token here
          </Link>
        </p>
      </div>
    </div>
  );
}
