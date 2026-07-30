import { useState, type FormEvent } from "react";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import type { CurrentUser } from "../App.js";

export default function SetupPage({ onComplete }: { onComplete: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ user: CurrentUser }>("/api/setup", {
        email,
        password,
        displayName,
      });
      onComplete(res.user);
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
        <h1>Create the first administrator account</h1>
        <p className="ph-subtitle">
          This ProjectHub instance has no users yet. The account you create here
          becomes the first platform administrator.
        </p>
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
            {loading ? "Creating..." : "Create administrator account"}
          </button>
        </form>
      </div>
    </div>
  );
}
