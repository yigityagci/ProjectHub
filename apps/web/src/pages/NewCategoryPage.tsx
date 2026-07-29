import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

/**
 * Forced "create your first category" step (Option A, two-step project
 * creation — FINAL per product decision, see docs/PHASES.md). Reached
 * immediately after a project is created (via `?first=true`) or via the
 * "create the first category" CTA on the category picker's zero-category
 * empty state. Deliberately has NO skip/cancel affordance: a project simply
 * cannot be used until it has at least one category, so this step must be
 * completed before the caller can reach any board.
 *
 * This is NOT the same UI as the optional "+ New category" inline form on
 * CategoriesPage.tsx (which has a Cancel button, since adding an
 * *additional* category to a project that already has one is optional) —
 * this route only ever runs when the project's category list is empty.
 */
export default function NewCategoryPage({ user }: { user: CurrentUser }) {
  void user; // Not shown directly on this single-purpose, single-form page.
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">("workspace");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    api
      .get<{ project: { name: string } }>(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .then((res) => setProjectName(res.project.name))
      .catch(() => undefined);
  }, [workspaceId, projectId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setCreating(true);
    try {
      const res = await api.post<{ category: Category }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories`,
        { name: trimmed, visibility },
      );
      navigate(`/workspace/${workspaceId}/projects/${projectId}/categories/${res.category.id}/board`, {
        replace: true,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this category. Please try again.");
      setCreating(false);
    }
  }

  return (
    <div className="ph-shell">
      <div className="ph-topbar">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
        </div>
      </div>
      <div className="ph-card">
        <h1 style={{ fontSize: "1.1rem" }}>Set up your first category</h1>
        <p className="ph-subtitle">
          {projectName ? `"${projectName}" needs at least one category before you can start working.` : "Loading..."}{" "}
          A category is its own working board (like a folder) inside the project — you can add more later.
        </p>
        {error && <div className="ph-alert ph-alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="ph-field">
            <label htmlFor="firstCategoryName">Category name</label>
            <input
              id="firstCategoryName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Engineering, Design, Sprint 1..."
              required
              autoFocus
            />
          </div>
          <div className="ph-field">
            <label htmlFor="firstCategoryVisibility">Visibility</label>
            <select
              id="firstCategoryVisibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "workspace" | "private")}
            >
              <option value="workspace">Workspace — visible to every project member</option>
              <option value="private">Private — only category members and managers</option>
            </select>
          </div>
          <button className="ph-button" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create category and go to the board"}
          </button>
        </form>
      </div>
    </div>
  );
}
