import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import type { CurrentUser } from "../App.js";

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  archived: boolean;
}

const CAN_CREATE_PROJECT_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

export default function ProjectsPage({ user }: { user: CurrentUser }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();

  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [role, setRole] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">("workspace");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    if (!workspaceId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setWorkspaceName(ws.workspace.name);
      setRole(ws.role);

      const res = await api.get<{ projects: Project[] }>(`/api/workspaces/${workspaceId}/projects`);
      setProjects(res.projects);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate("/");
        return;
      }
      setProjects([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setError(null);
    setCreating(true);
    try {
      await api.post(`/api/workspaces/${workspaceId}/projects`, { name, visibility });
      setName("");
      setVisibility("workspace");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  const canCreate = role !== null && CAN_CREATE_PROJECT_ROLES.has(role);

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> / {workspaceName || "..."}
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Projects</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              Projects you have access to in {workspaceName || "this workspace"}.
            </p>
          </div>
        </div>

        {projects === null ? (
          <p>Loading...</p>
        ) : projects.length === 0 ? (
          <div className="ph-empty-state">
            No projects yet.{" "}
            {canCreate ? "Create your first project below to get started." : "Ask a project manager or admin to create one."}
          </div>
        ) : (
          <ul className="ph-project-list">
            {projects.map((p) => (
              <li key={p.id}>
                <Link className="ph-project-card" to={`/workspace/${workspaceId}/projects/${p.id}/board`}>
                  <span>{p.name}</span>
                  <span className="ph-project-card-meta">
                    {p.visibility === "private" && <span className="ph-badge ph-badge-private">Private</span>}
                    <span className={`ph-badge ph-badge-status-${p.status}`}>{p.status.replace("_", " ")}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {canCreate && (
          <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Create a new project</h1>
            {error && <div className="ph-alert ph-alert-error">{error}</div>}
            <form onSubmit={handleCreate}>
              <div className="ph-field">
                <label htmlFor="projName">Project name</label>
                <input id="projName" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="ph-field">
                <label htmlFor="projVisibility">Visibility</label>
                <select
                  id="projVisibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as "workspace" | "private")}
                >
                  <option value="workspace">Workspace — visible to every workspace member</option>
                  <option value="private">Private — only project members and managers</option>
                </select>
              </div>
              <button className="ph-button" type="submit" disabled={creating || !name.trim()}>
                {creating ? "Creating..." : "Create project"}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
