import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import ThemeToggle from "../components/ThemeToggle.js";
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

  // Phase 7 search/filter: the projects list is filtered server-side (a
  // workspace can have many projects), debounced so `q` doesn't fire a
  // request on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [archivedFilter, setArchivedFilter] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  async function load() {
    if (!workspaceId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setWorkspaceName(ws.workspace.name);
      setRole(ws.role);

      const params = new URLSearchParams();
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (statusFilter) params.set("status", statusFilter);
      if (archivedFilter) params.set("archived", archivedFilter);
      const qs = params.toString();

      const res = await api.get<{ projects: Project[] }>(
        `/api/workspaces/${workspaceId}/projects${qs ? `?${qs}` : ""}`,
      );
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
  }, [workspaceId, debouncedQuery, statusFilter, archivedFilter]);

  const hasActiveFilters = Boolean(searchInput || statusFilter || archivedFilter);
  function clearFilters() {
    setSearchInput("");
    setStatusFilter("");
    setArchivedFilter("");
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setError(null);
    setCreating(true);
    try {
      // Project creation stays exactly this simple (name + visibility only
      // — no category field here, per the Option A two-step creation UX,
      // see docs/PHASES.md). A brand-new project always has zero
      // categories; immediately after creation we forward the user into
      // the mandatory "create your first category" step rather than back
      // into this list.
      const res = await api.post<{ project: { id: string } }>(`/api/workspaces/${workspaceId}/projects`, {
        name,
        visibility,
      });
      setName("");
      setVisibility("workspace");
      navigate(
        `/workspace/${workspaceId}/projects/${res.project.id}/categories/new?first=true`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setCreating(false);
    }
  }

  const canCreate = role !== null && CAN_CREATE_PROJECT_ROLES.has(role);

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
        </div>
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

        <div className="ph-filter-bar">
          <input
            type="search"
            placeholder="Search projects by name or description..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search projects"
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="planning">Planning</option>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="completed">Completed</option>
          </select>
          <select
            value={archivedFilter}
            onChange={(e) => setArchivedFilter(e.target.value)}
            aria-label="Filter by archived status"
          >
            <option value="">Active + archived</option>
            <option value="false">Not archived</option>
            <option value="true">Archived only</option>
          </select>
          {hasActiveFilters && (
            <button type="button" className="ph-button ph-button-secondary ph-filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        {projects === null ? (
          <p>Loading...</p>
        ) : projects.length === 0 ? (
          <div className="ph-empty-state">
            {hasActiveFilters ? (
              "No projects match your search/filters."
            ) : (
              <>
                No projects yet.{" "}
                {canCreate
                  ? "Create your first project below to get started."
                  : "Ask a project manager or admin to create one."}
              </>
            )}
          </div>
        ) : (
          <ul className="ph-project-list">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  className="ph-project-card"
                  to={`/workspace/${workspaceId}/projects/${p.id}/categories`}
                >
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
