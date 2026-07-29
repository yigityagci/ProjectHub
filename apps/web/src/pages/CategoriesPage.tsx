import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import type { CurrentUser } from "../App.js";

interface Category {
  id: string;
  projectId: string;
  name: string;
  visibility: "workspace" | "private";
}

// Mirrors CAN_CREATE_PROJECT_ROLES/CAN_MANAGE_BOARD_ROLES's frontend-gating
// convention (packages/shared/src/roles.ts's `category.manage` grant) —
// these are UX affordance gates only, the real security boundary is the
// backend guard chain (requireCategoryAccess + requirePermission).
const CAN_MANAGE_CATEGORY_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

/**
 * Category picker: the project-level landing page a project card now links
 * to (instead of a board directly — see docs/PHASES.md, Option A two-step
 * creation UX). Lists categories the caller can see (the server already
 * access-filters, mirroring how the project list never leaks private
 * projects today), each linking to that category's own board.
 */
export default function CategoriesPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryVisibility, setNewCategoryVisibility] = useState<"workspace" | "private">("workspace");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!workspaceId || !projectId) return;
    try {
      const ws = await api.get<{ role: string }>(`/api/workspaces/${workspaceId}`);
      setRole(ws.role);

      const projectRes = await api.get<{ project: { name: string } }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
      );
      setProjectName(projectRes.project.name);

      const res = await api.get<{ categories: Category[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories`,
      );
      setCategories(res.categories);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/workspace/${workspaceId}/projects`);
        return;
      }
      setCategories([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const canManageCategories = role !== null && CAN_MANAGE_CATEGORY_ROLES.has(role);

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    const name = newCategoryName.trim();
    if (!name) return;
    setError(null);
    setCreating(true);
    try {
      const res = await api.post<{ category: Category }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories`,
        { name, visibility: newCategoryVisibility },
      );
      setNewCategoryName("");
      setNewCategoryVisibility("workspace");
      setAddingCategory(false);
      await load();
      // Go straight into the freshly-created category's board — the same
      // "create then immediately enter" flow the forced first-category
      // step uses (see NewCategoryPage.tsx), just optional here.
      navigate(`/workspace/${workspaceId}/projects/${projectId}/categories/${res.category.id}/board`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> / {projectName || "..."}
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Categories</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              Each category is its own working board within {projectName || "this project"}.
            </p>
          </div>
        </div>

        {categories === null ? (
          <p>Loading...</p>
        ) : categories.length === 0 ? (
          <div className="ph-empty-state">
            {canManageCategories ? (
              // A permitted (rank-elevated) caller sees every category in
              // this project regardless of visibility (same rule as
              // requireCategoryAccess's elevated-rank escape hatch) — so an
              // empty list for THIS caller unambiguously means the project
              // really does have zero categories, never "categories exist
              // but I can't see them." Safe to offer the creation CTA here.
              <>
                <p style={{ margin: "0 0 0.75rem" }}>
                  This project has no categories yet — create the first one to start building its board.
                </p>
                <button
                  type="button"
                  className="ph-button"
                  style={{ width: "auto" }}
                  onClick={() =>
                    navigate(`/workspace/${workspaceId}/projects/${projectId}/categories/new?first=true`)
                  }
                >
                  Create the first category
                </button>
              </>
            ) : (
              // A non-privileged caller cannot tell (and must not be able
              // to tell) whether this project genuinely has zero
              // categories, or has categories that are simply all private
              // and invisible to them — the API deliberately returns the
              // same empty array either way to avoid leaking a private
              // category's existence. Show the safe, non-leaking copy and
              // offer no action.
              "You don't have access to any categories in this project yet."
            )}
          </div>
        ) : (
          <ul className="ph-category-list">
            {categories.map((c) => (
              <li key={c.id}>
                <Link
                  className="ph-category-card gap-3"
                  to={`/workspace/${workspaceId}/projects/${projectId}/categories/${c.id}/board`}
                >
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="ph-category-card-meta shrink-0">
                    {c.visibility === "private" && <span className="ph-badge ph-badge-private">Private</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {canManageCategories && categories !== null && categories.length > 0 && (
          <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
            {addingCategory ? (
              <>
                <h1 style={{ fontSize: "1rem" }}>New category</h1>
                {error && <div className="ph-alert ph-alert-error">{error}</div>}
                <form onSubmit={handleCreateCategory}>
                  <div className="ph-field">
                    <label htmlFor="catName">Category name</label>
                    <input
                      id="catName"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="ph-field">
                    <label htmlFor="catVisibility">Visibility</label>
                    <select
                      id="catVisibility"
                      value={newCategoryVisibility}
                      onChange={(e) => setNewCategoryVisibility(e.target.value as "workspace" | "private")}
                    >
                      <option value="workspace">Workspace — visible to every project member</option>
                      <option value="private">Private — only category members and managers</option>
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <button
                      className="ph-button"
                      style={{ width: "auto" }}
                      type="submit"
                      disabled={creating || !newCategoryName.trim()}
                    >
                      {creating ? "Creating..." : "Create category"}
                    </button>
                    <button
                      type="button"
                      className="ph-button ph-button-secondary"
                      style={{ width: "auto" }}
                      onClick={() => {
                        setAddingCategory(false);
                        setNewCategoryName("");
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <button
                type="button"
                className="ph-button ph-button-secondary"
                onClick={() => setAddingCategory(true)}
              >
                + New category
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
