import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import SettingsGearLink from "../components/SettingsGearLink.js";
import type { CurrentUser } from "../App.js";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export default function WorkspacesPage({
  user,
  onLogout,
}: {
  user: CurrentUser;
  onLogout: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function loadWorkspaces() {
    const res = await api.get<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
    setWorkspaces(res.workspaces);
  }

  useEffect(() => {
    loadWorkspaces().catch(() => setWorkspaces([]));
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.post("/api/workspaces", { name, slug: slugify(name) });
      setName("");
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  async function handleLogout() {
    await api.post("/api/auth/logout").catch(() => undefined);
    onLogout();
  }

  return (
    <div className="ph-shell">
      <div className="ph-topbar">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
          <SettingsGearLink />
          <button className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="ph-card ph-card-wide">
        <h1>Your workspaces</h1>
        <p className="ph-subtitle">Workspaces you're an active member of.</p>

        {workspaces === null ? (
          <p>Loading...</p>
        ) : workspaces.length === 0 ? (
          <p className="ph-subtitle">You aren't a member of any workspace yet.</p>
        ) : (
          <ul className="ph-workspace-list">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <Link className="ph-workspace-card gap-3" to={`/workspace/${ws.id}/projects`}>
                  <span className="min-w-0 truncate" title={ws.name}>
                    {ws.name}
                  </span>
                  <span className="ph-role-badge shrink-0">{ws.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <h1 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Create a new workspace</h1>
        {error && <div className="ph-alert ph-alert-error">{error}</div>}
        <form onSubmit={handleCreate}>
          <div className="ph-field">
            <label htmlFor="wsName">Workspace name</label>
            <input id="wsName" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <button className="ph-button" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
